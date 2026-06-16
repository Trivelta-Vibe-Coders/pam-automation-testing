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
import { getFlow } from './services/autosana';
import * as envRestrictions from './services/env-restrictions';
import { scheduleNightlyRun } from './services/nightly-trigger';
import { backfillTicketMeta } from './services/meta-backfill';
import { startPolling } from './services/batch-poller';

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

// ── API: public config (safe, non-secret values used by the UI) ──────────────
app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    jiraBaseUrl:    config.jiraBaseUrl,
    autosanaAppUrl: config.autosanaAppUrl,
  });
});

// ── API: stored flow links ───────────────────────────────────────────────────
app.get('/api/links', (_req: Request, res: Response) => {
  const links = flowLinks.getAllLinks().map(link => ({
    ...link,
    jiraStatus: ticketStore.getTicket(link.jiraKey)?.jiraStatus ?? '',
  }));
  res.json(links);
});

app.post('/api/links', async (req: Request, res: Response) => {
  const { jiraKey, flowId } = req.body ?? {};
  if (!jiraKey || !flowId) {
    res.status(400).json({ error: 'jiraKey and flowId are required' });
    return;
  }
  if (!/^[A-Z]+-\d+$/i.test(String(jiraKey))) {
    res.status(400).json({ error: 'jiraKey must be in the format PROJECT-123' });
    return;
  }
  try {
    const flow      = await getFlow(String(flowId));
    const suiteName = Object.entries(config.suites).find(([, id]) => id === flow.suite_id)?.[0] ?? '';
    const key       = String(jiraKey).toUpperCase();
    const link      = flowLinks.addFlow(key, { flowId: flow.id, flowName: flow.name, suiteId: flow.suite_id });
    logger.success(`Flow link added: ${key} → "${flow.name}"`, { jiraKey: key, flowId: flow.id });
    res.json({ ok: true, link, suiteName });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Remove a single flow from a ticket's link list
app.delete('/api/links/:jiraKey/flows/:flowId', (req: Request, res: Response) => {
  const jiraKey = req.params.jiraKey.toUpperCase();
  const flowId  = req.params.flowId;
  const removed = flowLinks.removeFlow(jiraKey, flowId);
  if (removed) {
    logger.info(`Flow removed from link: ${jiraKey} → ${flowId}`);
    res.json({ ok: true });
  } else {
    res.status(404).json({ ok: false, error: 'Link or flow not found' });
  }
});

// Remove all flows for a ticket
app.delete('/api/links/:jiraKey', (req: Request, res: Response) => {
  const { jiraKey } = req.params;
  const deleted = flowLinks.deleteLink(jiraKey.toUpperCase());
  if (deleted) {
    logger.info(`All flow links removed for: ${jiraKey}`);
    res.json({ ok: true });
  } else {
    res.status(404).json({ ok: false, error: 'Link not found' });
  }
});

// ── API: persistent ticket records ───────────────────────────────────────────
app.get('/api/tickets', (_req: Request, res: Response) => {
  res.json(ticketStore.getAllTickets());
});

// ── API: in-progress epics (live from Jira) ───────────────────────────────────
app.get('/api/epics', async (_req: Request, res: Response) => {
  try {
    const issues = await jiraClient.searchIssues(
      `project = ${config.jiraProject} AND issuetype = Epic AND statusCategory = "In Progress" ORDER BY updated DESC`,
      ['summary', 'status'],
      200,
    );
    res.json(issues.map(i => ({ key: i.key, summary: i.fields.summary })));
  } catch (err) {
    logger.warn('Failed to fetch in-progress epics from Jira', { error: String(err) });
    res.json([]);
  }
});

app.post('/api/tickets/:key/no-test-needed', (req: Request, res: Response) => {
  const key   = req.params.key.toUpperCase();
  const value = req.body?.value !== false; // defaults to true
  ticketStore.setNoTestNeeded(key, value);
  logger.info(`${key} manually marked as ${value ? 'no test needed' : 'test needed'}`, { key });
  res.json({ ok: true, key, noTestNeeded: value });
});

// ── API: environment restrictions ────────────────────────────────────────────
app.get('/api/env-restrictions', (_req: Request, res: Response) => {
  res.json(envRestrictions.getAll());
});

app.post('/api/env-restrictions', (req: Request, res: Response) => {
  const { flowId, environment, excluded } = req.body ?? {};
  if (!flowId || !environment || typeof excluded !== 'boolean') {
    res.status(400).json({ error: 'flowId, environment, and excluded (boolean) are required' });
    return;
  }
  envRestrictions.setExclusion(String(flowId), String(environment), excluded);
  res.json({ ok: true });
});

// ── API: manual re-run linked flows for a ticket ─────────────────────────────
app.post('/api/tickets/:key/rerun', async (req: Request, res: Response) => {
  const key = req.params.key.toUpperCase();
  const env = (req.body?.environment ?? 'staging') as TriggerEnvironment;

  const link = flowLinks.getLink(key);
  if (!link || !link.flows.length) {
    res.status(404).json({ ok: false, error: 'No flow links found for this ticket' });
    return;
  }

  // Respect env restrictions so prod-only flows don't run in dev/staging
  let flowIds = link.flows.map(f => f.flowId);
  if (env === 'dev') {
    flowIds = flowIds.filter(id => !envRestrictions.isExcluded(id, 'dev'));
  } else if (env === 'staging') {
    flowIds = flowIds.filter(id => !envRestrictions.isExcluded(id, 'staging'));
  } else if (env === 'production') {
    flowIds = flowIds.filter(id =>
      envRestrictions.isExcluded(id, 'dev') && envRestrictions.isExcluded(id, 'staging'),
    );
  }

  if (!flowIds.length) {
    res.status(400).json({ ok: false, error: `No flows eligible to run in ${env} (check env restrictions)` });
    return;
  }

  try {
    const result = await triggerFlows({ environment: env, flowIds, jiraKey: key });
    startPolling({ batchId: result.batchId, environment: env, triggeredBy: key });
    logger.success(`Manual re-run triggered for ${key} in ${env}`, {
      key, env, batchId: result.batchId, flowCount: result.flowRunCount,
    });
    res.json({ ok: true, batchId: result.batchId, flowCount: result.flowRunCount });
  } catch (err) {
    logger.error(`Manual re-run failed for ${key}`, { error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
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

// ── API: deployment readiness dashboard ──────────────────────────────────────
// Status patterns — kept in sync with the client-side jiraStatusClass() logic
const DEV_STATUS_RE = /^(dev|in dev)$/i;          // tickets ready to move to staging
const STG_STATUS_RE = /^(stg|staging|stage)$/i;   // tickets ready to move to production

app.get('/api/dashboard', (_req: Request, res: Response) => {
  const allTickets = ticketStore.getAllTickets();
  const allLinks   = flowLinks.getAllLinks();
  const linkedKeys = new Set(allLinks.map(l => l.jiraKey));

  // "Ready for Stg?" checks tickets currently in Dev — they're about to be pushed to staging
  const devTickets = allTickets.filter(t => t.sprintIsActive && DEV_STATUS_RE.test(t.jiraStatus ?? ''));
  // "Ready for Prod?" checks tickets currently in Staging — they're about to go to production
  const stgTickets = allTickets.filter(t => t.sprintIsActive && STG_STATUS_RE.test(t.jiraStatus ?? ''));

  // ── Helper: find the most recent test-result event for a ticket ───────────
  interface FailedFlow { name: string; summary: string; runUrl?: string; suiteName: string }
  interface TestResult {
    timestamp:   string;
    environment: string;
    passed:      boolean;
    testSummary: string;   // AI-generated summary from the activity log event
    failedFlows: FailedFlow[];
  }

  function latestResult(ticket: ticketStore.TicketRecord, env: string | null): TestResult | null {
    const events = ticket.events
      .filter(e => Array.isArray(e.details?.testResults))
      .filter(e => env === null || e.details?.environment === env)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (!events.length) return null;
    const ev   = events[0];
    const rows = ev.details!.testResults as Array<{
      suiteName:      string;
      runUrl?:        string;
      passed:         number;
      failed:         number;
      allFlowDetails?: Array<{ name: string; status: string; summary: string }>;
      failedFlowDetails?: Array<{ name: string; summary: string }>;
    }>;

    const failedFlows: FailedFlow[] = rows.flatMap(r => {
      const flows = r.allFlowDetails
        ? r.allFlowDetails.filter(f => f.status !== 'passed')
        : (r.failedFlowDetails ?? []);
      return flows.map(f => ({
        name:      f.name,
        summary:   f.summary ?? '',
        runUrl:    r.runUrl,
        suiteName: r.suiteName,
      }));
    });

    return {
      timestamp:   ev.timestamp,
      environment: String(ev.details?.environment ?? 'unknown'),
      passed:      failedFlows.length === 0,
      testSummary: String(ev.details?.testSummary ?? ''),
      failedFlows,
    };
  }

  // ── Blocker + manual-ticket shapes ───────────────────────────────────────
  interface Blocker {
    type:         'no_link' | 'test_failed' | 'never_tested';
    ticketKey:    string;
    ticketTitle:  string;
    jiraStatus:   string;
    jiraUrl:      string;
    testSummary?: string;
    failedFlows?: FailedFlow[];
  }
  interface ManualTicket {
    ticketKey:   string;
    ticketTitle: string;
    jiraUrl:     string;
  }

  function buildCardData(
    tickets: ticketStore.TicketRecord[],
    env: string | null,
  ): { blockers: Blocker[]; manualTestTickets: ManualTicket[] } {
    const blockers:          Blocker[]       = [];
    const manualTestTickets: ManualTicket[]  = [];

    for (const ticket of tickets) {
      const jiraUrl = `${config.jiraBaseUrl}/browse/${ticket.key}`;
      const title   = ticket.title || ticket.key;
      const status  = ticket.jiraStatus ?? '';

      if (ticket.noTestNeeded) {
        manualTestTickets.push({ ticketKey: ticket.key, ticketTitle: title, jiraUrl });
        continue;
      }

      if (!linkedKeys.has(ticket.key)) {
        blockers.push({ type: 'no_link', ticketKey: ticket.key, ticketTitle: title, jiraStatus: status, jiraUrl });
        continue;
      }

      const result = latestResult(ticket, env);
      if (!result) {
        blockers.push({ type: 'never_tested', ticketKey: ticket.key, ticketTitle: title, jiraStatus: status, jiraUrl });
      } else if (!result.passed) {
        blockers.push({
          type: 'test_failed', ticketKey: ticket.key, ticketTitle: title, jiraStatus: status, jiraUrl,
          testSummary: result.testSummary || undefined,
          failedFlows: result.failedFlows,
        });
      }
    }
    return { blockers, manualTestTickets };
  }

  const stagingData = buildCardData(devTickets, null);
  const prodData    = buildCardData(stgTickets, 'staging');

  res.json({
    staging: {
      ready:             stagingData.blockers.length === 0,
      checkedTickets:    devTickets.length,
      blockers:          stagingData.blockers,
      manualTestTickets: stagingData.manualTestTickets,
    },
    production: {
      ready:             prodData.blockers.length === 0,
      checkedTickets:    stgTickets.length,
      blockers:          prodData.blockers,
      manualTestTickets: prodData.manualTestTickets,
    },
  });
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

  // Backfill sprint/epic for tickets that pre-date this feature (non-blocking)
  backfillTicketMeta().catch(() => {});
});

export default app;
