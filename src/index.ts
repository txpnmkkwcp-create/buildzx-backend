import express, { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { Octokit } from '@octokit/rest';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const PROXY_API_BASE = process.env.PROXY_API_BASE || 'https://api.quatarly.cloud/v1';
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER || 'jalalboss123';
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME || 'buildzx-apps';
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const DEPLOY_TIMEOUT_MS = parseInt(process.env.DEPLOY_TIMEOUT_MS || '120000', 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ── HEALTH ────────────────────────────────────
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── AUTH ───────────────────────────────────────
app.post('/api/auth/signup', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ user: data.user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/signin', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ session: data.session });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROJECTS ───────────────────────────────────
app.get('/api/projects', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return res.status(401).json({ error: 'Invalid token' });

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', userData.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ projects: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return res.status(401).json({ error: 'Invalid token' });

    const { title, prompt } = req.body;
    const projectId = crypto.randomUUID();

    const { data, error } = await supabase
      .from('projects')
      .insert({
        id: projectId,
        user_id: userData.user.id,
        title: title || 'Untitled Project',
        prompt,
        status: 'idle',
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ project: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();

    if (error) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE (NEW) ─────────────────────────────
app.post('/api/projects/:id/generate', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { prompt } = req.body;
    const authHeader = req.headers.authorization;

    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

    const token = authHeader.split(' ')[1];
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return res.status(401).json({ error: 'Invalid token' });

    // Update status to generating
    await supabase
      .from('projects')
      .update({ status: 'generating' })
      .eq('id', id);

    // Save message
    await supabase
      .from('messages')
      .insert({
        project_id: id,
        user_id: userData.user.id,
        role: 'user',
        content: prompt,
      });

    // Call Proxy API (Claude via Quatarly)
    const systemPrompt = `You are a full-stack AI developer. Generate production-ready code for a web app based on the user's prompt. 
Return ONLY valid TypeScript/React/Express code. No explanations, no markdown, just code.
Structure: 
- For frontend: React + TypeScript component (App.tsx)
- For backend: Express routes (if needed)
- Include necessary imports and exports.`;

    const claudeRes = await fetch(`${PROXY_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PROXY_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-sonnet',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      throw new Error(`Proxy API error: ${claudeRes.statusText}`);
    }

    const claudeData: any = await claudeRes.json();
    const generatedCode = claudeData.content?.[0]?.text || '';

    if (!generatedCode) {
      throw new Error('No code generated');
    }

    // Generate unique slug
    const slug = `${id.slice(0, 8)}-${Math.random().toString(36).slice(2, 7)}`;

    // Commit to GitHub
    const fileName = 'App.tsx';
    const filePath = `apps/${slug}/${fileName}`;
    const branchName = `app-${slug}`;

    // Get default branch SHA
    const mainBranch = await octokit.repos.getBranch({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      branch: 'main',
    });

    const baseSha = mainBranch.data.commit.sha;

    // Create new branch
    await octokit.git.createRef({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    // Commit file
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      path: filePath,
      message: `feat: generate app ${slug}`,
      content: Buffer.from(generatedCode).toString('base64'),
      branch: branchName,
    });

    // Create PR
    const pr = await octokit.pulls.create({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      title: `Deploy ${slug}`,
      body: `Generated app from prompt: ${prompt.slice(0, 100)}...`,
      head: branchName,
      base: 'main',
    });

    // Merge PR
    await octokit.pulls.merge({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      pull_number: pr.data.number,
      merge_method: 'squash',
    });

    // Delete branch
    await octokit.git.deleteRef({
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      ref: `heads/${branchName}`,
    });

    const liveUrl = `https://${slug}.buildzx.app`;

    // Save to DB
    await supabase
      .from('projects')
      .update({
        code: generatedCode,
        status: 'deployed',
        live_url: liveUrl,
      })
      .eq('id', id);

    // Save assistant message
    await supabase
      .from('messages')
      .insert({
        project_id: id,
        user_id: userData.user.id,
        role: 'assistant',
        content: `✓ Generated and deployed to ${liveUrl}`,
      });

    res.json({
      success: true,
      slug,
      liveUrl,
      code: generatedCode,
    });
  } catch (err: any) {
    // Update status to failed
    await supabase
      .from('projects')
      .update({ status: 'failed' })
      .eq('id', req.params.id)
      .catch(() => {});

    res.status(500).json({ error: err.message });
  }
});

// ── STATUS ─────────────────────────────────────
app.get('/api/projects/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('projects')
      .select('status, live_url')
      .eq('id', id)
      .single();

    if (error) return res.status(404).json({ error: 'Project not found' });
    res.json({ status: data.status, liveUrl: data.live_url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── LOGS ───────────────────────────────────────
app.get('/api/projects/:id/logs', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ logs: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEPLOY (STUB) ─────────────────────────────
app.post('/api/projects/:id/deploy', async (req: Request, res: Response) => {
  res.json({ status: 'deploying' });
});

// ── START ──────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;