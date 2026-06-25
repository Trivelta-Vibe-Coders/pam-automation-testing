/**
 * POST /slack-action
 *
 * Handles Slack interactive button callbacks — specifically the "Create Bug"
 * button that appears in PAM QA Slack reports after a test run.
 *
 * Replaces the equivalent handler that was in the Cloudflare Worker
 * (pam-webhook-dispatcher.js). The Slack App "Interactivity & Shortcuts"
 * Request URL should point here.
 *
 * Requires SLACK_SIGNING_SECRET in Railway env vars.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import * as logger from '../logger';

export const slackActionRouter = Router();

// ── Slack signature verification ──────────────────────────────────────────────

function verifySlackSignature(rawBody: string, req: Request): boolean {
  const secret = config.slackSigningSecret;
  if (!secret) return true; // skip verification if secret not configured

  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig  = req.headers['x-slack-signature'];
  if (typeof timestamp !== 'string' || typeof slackSig !== 'string') return false;

  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false;

  const computed = 'v0=' + crypto
    .createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
}

// ── Jira ADF helpers ──────────────────────────────────────────────────────────

function adfH(level: number, text: string) {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}
function adfP(text: string) {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}
function adfBullets(items: string[]) {
  return {
    type: 'bulletList',
    content: items.map(t => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
    })),
  };
}
function adfOrdered(items: string[]) {
  return {
    type: 'orderedList',
    content: items.map(t => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
    })),
  };
}
function adfTableRow(cells: string[], isHeader = false) {
  const cellType = isHeader ? 'tableHeader' : 'tableCell';
  return {
    type: 'tableRow',
    content: cells.map(text => ({
      type: cellType,
      content: [{ type: 'paragraph', content: [{
        type: 'text', text,
        ...(isHeader ? { marks: [{ type: 'strong' }] } : {}),
      }] }],
    })),
  };
}

interface BugData {
  rc:    string;  // root cause / title
  suite: string;
  flow:  string;
  sev:   string;
  sum:   string;  // summary
  env:   string;
  date:  string;
  exp?:  string;  // expected behaviour
  crit?: string[];
  bugs?: string[];
  acts?: string[];
  iss?:  string[];
}

function buildJiraDescription(data: BugData) {
  const content: unknown[] = [];

  content.push(adfH(3, 'Key Details'));
  content.push({
    type: 'table',
    content: [
      adfTableRow(['Field', 'Value'], true),
      adfTableRow(['Environment',    data.env || 'staging']),
      adfTableRow(['Suite / Module', data.suite]),
      adfTableRow(['Flow / Feature', data.flow]),
      adfTableRow(['Severity',       data.sev]),
      adfTableRow(['Run Date',       data.date || '']),
      adfTableRow(['Reported By',    'Autosana (PAM QA Automation)']),
    ],
  });

  content.push(adfH(3, 'Summary'));
  content.push(adfP(data.sum));

  content.push(adfH(3, 'Steps to Reproduce'));
  if ((data.acts ?? []).length) {
    content.push(adfOrdered(data.acts!));
  } else {
    content.push(adfP('Steps not captured — see Autosana run for details.'));
  }

  content.push(adfH(3, 'Expected Behaviour'));
  content.push(adfP(
    data.exp || `The ${data.flow} flow should complete without errors.`,
  ));

  content.push(adfH(3, 'Actual Behaviour'));
  content.push(adfP(data.sum));
  if ((data.bugs ?? []).length) content.push(adfBullets(data.bugs!));

  content.push(adfH(3, 'Error Output / Logs'));
  if ((data.iss ?? []).length) {
    content.push({
      type: 'codeBlock', attrs: { language: 'text' },
      content: [{ type: 'text', text: data.iss!.join('\n') }],
    });
  } else {
    content.push(adfP('No error output captured.'));
  }

  content.push(adfH(3, 'Acceptance Criteria'));
  const criteria = (data.crit ?? []).length
    ? data.crit!
    : [`${data.flow} completes without errors`, 'No unexpected errors or session issues occur', 'Automated test passes on re-run'];
  content.push({
    type: 'taskList',
    attrs: { localId: 'ac-list' },
    content: criteria.map((c, i) => ({
      type: 'taskItem',
      attrs: { localId: `ac-${i}`, state: 'TODO' },
      content: [{ type: 'text', text: c }],
    })),
  });

  content.push(adfH(3, 'Additional Context'));
  content.push(adfP(`Source: PAM QA Automation (Autosana) · Suite: ${data.suite} · ${data.date || ''}`));

  return { version: 1, type: 'doc', content };
}

// ── Jira ticket creation ──────────────────────────────────────────────────────

const PRIORITY_MAP: Record<string, string> = {
  'Critical / Blocker': 'Highest',
  'High':               'High',
  'Medium':             'Medium',
  'Low':                'Low',
};

async function createJiraTicket(data: BugData): Promise<{ key: string }> {
  const auth = Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64');
  const resp = await fetch(`${config.jiraBaseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept':        'application/json',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      fields: {
        project:     { key: config.jiraProject },
        issuetype:   { id: '10199' },
        summary:     `[PAM QA] ${data.rc} — ${data.flow}`,
        description: buildJiraDescription(data),
        priority:          { name: PRIORITY_MAP[data.sev] ?? 'Medium' },
        labels:            ['pam-qa'],
        customfield_10456: [{ accountId: '712020:aff69ccc-6b48-436a-8d73-bcce98f8c937' }],
        customfield_10457: { id: '10305' },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Jira ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<{ key: string }>;
}

// ── Slack confirmation blocks ──────────────────────────────────────────────────

function buildConfirmationBlocks(issue: { key: string }, data: BugData): unknown[] {
  const issueUrl = `${config.jiraBaseUrl}/browse/${issue.key}`;
  const sevEmoji: Record<string, string> = {
    'Critical / Blocker': ':red_circle:',
    'High':               ':large_yellow_circle:',
    'Medium':             ':large_blue_circle:',
    'Low':                ':white_circle:',
  };
  const fmt = (arr?: string[]) =>
    arr?.length ? arr.map(x => `• ${x}`).join('\n') : '_None recorded_';

  return [
    { type: 'section', text: { type: 'mrkdwn',
        text: `:beetle: *<${issueUrl}|${issue.key}>* created for *${data.rc}*` } },
    { type: 'divider' },
    { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Suite*\n${data.suite}` },
        { type: 'mrkdwn', text: `*Flow*\n${data.flow}` },
        { type: 'mrkdwn', text: `*Severity*\n${sevEmoji[data.sev] ?? ':red_circle:'} ${data.sev}` },
        { type: 'mrkdwn', text: `*Environment*\n\`${data.env || 'staging'}\` · ${data.date || ''}` },
    ]},
    { type: 'section', text: { type: 'mrkdwn', text: `*What Failed*\n${data.sum}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Bugs Observed*\n${fmt(data.bugs)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Issues Detected*\n${fmt(data.iss)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Last Steps Before Failure*\n${fmt(data.acts)}` } },
  ];
}

// ── Route ─────────────────────────────────────────────────────────────────────

// Use text() to capture the raw body needed for signature verification.
// Slack sends application/x-www-form-urlencoded.
slackActionRouter.post(
  '/',
  (req: Request, res: Response, next) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      (req as Request & { rawBody: string }).rawBody = raw;
      next();
    });
  },
  async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody: string }).rawBody ?? '';

    if (!verifySlackSignature(rawBody, req)) {
      res.status(401).send('Unauthorized');
      return;
    }

    // Slack sends payload as a form-encoded JSON string
    const params  = new URLSearchParams(rawBody);
    const payload = JSON.parse(params.get('payload') ?? '{}');

    const action      = payload.actions?.[0];
    const responseUrl = payload.response_url;

    if (!action || action.action_id !== 'create_jira_bug' || !responseUrl) {
      res.status(200).send('');
      return;
    }

    // Acknowledge immediately — Slack requires a response within 3 seconds
    res.status(200).send('');

    void (async () => {
      try {
        const data: BugData = JSON.parse(action.value);
        const issue = await createJiraTicket(data);
        logger.success(`Slack action: created Jira ticket ${issue.key}`, { key: issue.key, flow: data.flow });

        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            response_type:    'in_channel',
            replace_original: false,
            blocks:           buildConfirmationBlocks(issue, data),
          }),
        });
      } catch (err) {
        logger.error('Slack action: failed to create Jira ticket', { error: String(err) });
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            replace_original: false,
            text: `:x: Failed to create Jira ticket: ${String(err)}`,
          }),
        }).catch(() => {});
      }
    })();
  },
);
