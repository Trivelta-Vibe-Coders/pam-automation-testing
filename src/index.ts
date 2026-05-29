/**
 * PAM QA Agent — Express server
 *
 * Routes:
 *   GET  /             → Live activity log UI (HTML)
 *   GET  /events       → Server-Sent Events stream
 *   GET  /health       → Health check (Railway)
 *   GET  /api/links    → All stored flow links (JSON)
 *   POST /webhook/jira → Jira webhook receiver
 *   POST /api/trigger  → Manual trigger (dev/staging)
 *   POST /api/register-webhook → Register Jira webhook
 */
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { config } from './config';
import * as logger from './logger';
import { webhookRouter } from './routes/webhook';
import { runnerRouter } from './routes/runner';
import * as flowLinks   from './services/flow-links';
import * as ticketStore from './services/ticket-store';
import { triggerFlows, TriggerEnvironment } from './services/autosana-trigger';
import * as jiraClient from './services/jira';
import { scheduleNightlyRun } from './services/nightly-trigger';

// ── Global error safety net (logs crashes to Railway deploy logs) ─────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

console.log(`[BOOT] PORT env = ${process.env['PORT']} | using port ${config.port}`);

const app = express();

// ── Body parsing (capture raw body for signature verification) ─────────────
app.use(
  express.json({
    verify(req: any, _res, buf) {
      req.rawBody = buf;
    },
  }),
);

// ── Static files (activity log UI) ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// ── SSE event stream ──────────────────────────────────────────────────────────
app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send all buffered history first
  for (const ev of logger.getHistory()) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  // Keep-alive ping every 25 seconds
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);

  logger.addSubscriber(res);
  req.on('close', () => {
    clearInterval(ping);
    logger.removeSubscriber(res);
  });
});

// ── API: stored flow links ───────────────────────────────────────────────────
app.get('/api/links', (_req: Request, res: Response) => {
  res.json(flowLinks.getAllLinks());
});

// ── API: persistent ticket records ───────────────────────────────────────────
app.get('/api/tickets', (_req: Request, res: Response) => {
  res.json(ticketStore.getAllTickets());
});

// ── API: manual trigger ───────────────────────────────────────────────────────
app.post('/api/trigger', async (req: Request, res: Response) => {
  const env = (req.body?.environment ?? 'staging') as TriggerEnvironment;
  const suiteIds: string[] | undefined = req.body?.suite_ids;

  try {
    const result = await triggerFlows({ environment: env, suiteIds });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── API: register Jira webhook ────────────────────────────────────────────────
app.post('/api/register-webhook', async (req: Request, res: Response) => {
  const publicUrl = req.body?.public_url as string | undefined;
  if (!publicUrl) {
    res.status(400).json({ error: 'public_url is required' });
    return;
  }

  const webhookUrl = `${publicUrl.replace(/\/$/, '')}/webhook/jira`;

  try {
    const result = await jiraClient.registerWebhook({
      name:      'PAM QA Agent',
      url:       webhookUrl,
      events:    ['jira:issue_created', 'jira:issue_updated'],
      jqlFilter: `project = ${config.jiraProject}`,
    });
    logger.success('Jira webhook registered', { id: result.createdWebhookId, webhookUrl });
    res.json({ ok: true, webhookId: result.createdWebhookId, webhookUrl });
  } catch (err) {
    logger.error('Failed to register Jira webhook', { error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ── Webhook routes ────────────────────────────────────────────────────────────
app.use('/webhook/jira', webhookRouter);

// ── Runner routes ─────────────────────────────────────────────────────────────
app.use('/api', runnerRouter);

// ── 404 fallback → serve index.html (SPA-style) ───────────────────────────────
app.use((_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled server error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.port, '0.0.0.0', () => {
  logger.info(`PAM QA Agent listening on 0.0.0.0:${config.port}`, {
    environment: process.env['NODE_ENV'] ?? 'development',
    jiraProject: config.jiraProject,
    threshold:   config.matchThreshold,
  });

  // Schedule nightly full regression against staging
  scheduleNightlyRun();
});

export default app;
