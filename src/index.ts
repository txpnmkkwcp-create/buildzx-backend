import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { nanoid } from 'nanoid';
import { z } from 'zod';

dotenv.config();

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

// ── TYPES ────────────────────────────────────────
interface AuthUser {
  id: string;
  email: string;
}

interface RequestWithUser extends Request {
  user?: AuthUser;
}

// ── SUPABASE ──────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

// ── MIDDLEWARE ────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

app.use((req: RequestWithUser, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    // Verify JWT with Supabase
    supabase.auth.getUser(token).then(({ data }) => {
      if (data.user) {
        req.user = {
          id: data.user.id,
          email: data.user.email || ''
        };
      }
      next();
    }).catch(() => next());
  } else {
    next();
  }
});

// ── VALIDATORS ────────────────────────────────────
const GenerateCodeSchema = z.object({
  prompt: z.string().min(10, 'Prompt too short').max(2000),
  model: z.enum(['opus', 'sonnet', 'gpt-4.5']).default('opus')
});

const ProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional()
});

// ── ROUTES ───────────────────────────────────────

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── AUTH ROUTES ───────────────────────────────────

// Sign up
app.post('/api/auth/signup', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Sign in
app.post('/api/auth/signin', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── PROJECT ROUTES ───────────────────────────────

// Get all projects for user
app.get('/api/projects', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Create new project
app.post('/api/projects', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const body = ProjectSchema.parse(req.body);
    const slug = `${body.name.toLowerCase().replace(/\s+/g, '-')}-${nanoid(6)}`;
    
    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id: req.user.id,
        name: body.name,
        description: body.description || '',
        slug,
        status: 'created',
        code: '// Your code will appear here\n',
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors });
    }
    res.status(500).json({ error: String(e) });
  }
});

// Get single project
app.get('/api/projects/:id', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GENERATION ROUTES ────────────────────────────

// Generate code from prompt
app.post('/api/projects/:id/generate', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const body = GenerateCodeSchema.parse(req.body);
    const projectId = req.params.id;

    // Verify project ownership
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', req.user.id)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Update status to generating
    await supabase
      .from('projects')
      .update({ status: 'generating' })
      .eq('id', projectId);

    // Call proxy API (OpenRouter, Together.ai, etc)
    const modelMap: Record<string, string> = {
      'opus': 'anthropic/claude-3-opus',
      'sonnet': 'anthropic/claude-3.5-sonnet',
      'gpt-4.5': 'openai/gpt-4-turbo'
    };

    const systemPrompt = `You are an expert web developer. Generate a complete, production-ready web application.

Requirements:
- Use React + TypeScript
- Include Tailwind CSS for styling
- Make it responsive and functional
- Include basic error handling
- Add comments explaining key parts
- Return ONLY the code, no markdown, no explanations

Generate a single HTML file or React component that can be deployed directly.`;

    const response = await axios.post(
      `${process.env.PROXY_API_BASE}/chat/completions`,
      {
        model: modelMap[body.model],
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: body.prompt }
        ],
        max_tokens: 4000,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.PROXY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: parseInt(process.env.DEPLOY_TIMEOUT_MS || '120000', 10)
      }
    );

    const generatedCode = response.data.choices[0]?.message?.content || '';

    // Save generated code to project
    const { data: updated, error: updateError } = await supabase
      .from('projects')
      .update({
        code: generatedCode,
        status: 'generated',
        last_prompt: body.prompt,
        updated_at: new Date().toISOString()
      })
      .eq('id', projectId)
      .select()
      .single();

    if (updateError) throw updateError;

    // TODO: Trigger git commit + deploy
    // For now, just return the generated code
    res.json({
      project: updated,
      generated: true,
      codeLength: generatedCode.length
    });

  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors });
    }
    if (axios.isAxiosError(e)) {
      return res.status(500).json({ error: `API Error: ${e.message}` });
    }
    res.status(500).json({ error: String(e) });
  }
});

// Get project build status
app.get('/api/projects/:id/status', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('id,slug,status,updated_at,url')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });

    res.json({
      ...data,
      liveUrl: data.url || `https://${data.slug}.buildzx.app`
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get build logs
app.get('/api/projects/:id/logs', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await supabase
      .from('build_logs')
      .select('*')
      .eq('project_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── DEPLOYMENT ROUTES ────────────────────────────

// Trigger deploy for a project
app.post('/api/projects/:id/deploy', async (req: RequestWithUser, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (projectError || !project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Update status
    await supabase
      .from('projects')
      .update({ status: 'deploying' })
      .eq('id', req.params.id);

    // TODO: Call GitHub API to commit code
    // TODO: Call deployment service (Render/Cloudflare) to build & deploy
    // TODO: Update DNS record for subdomain
    // TODO: Save URL to project

    res.json({
      success: true,
      message: 'Deploy queued',
      liveUrl: `https://${project.slug}.buildzx.app`
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── ERROR HANDLING ────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ── START SERVER ──────────────────────────────────
app.listen(port, () => {
  console.log(`BuildZX backend listening on port ${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
});
