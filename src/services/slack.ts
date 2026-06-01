/**
 * Slack notification helpers for the Railway app.
 *
 * Uses SLACK_WEBHOOK_URL (the same webhook as pam_report.py).
 * If the env var is not set, notifications are logged but not sent.
 */
import { config } from '../config';
import * as logger from '../logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FlowRecommendation {
  jiraKey:       string;
  jiraSummary:   string;
  issueType:     string;
  gateReason:    string;
  /** True when an existing Autosana flow was a close match (≥ threshold). */
  matchFound:    boolean;
  existingFlowName?:  string;
  existingFlowScore?: number;
  /** Suggested name for a new flow (when no match). */
  suggestedFlowName?: string;
  suiteName:     string;
  /** Generated or augmented instructions ready to paste into Autosana. */
  instructions:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function post(blocks: unknown[]): Promise<void> {
  const url = config.slackWebhookUrl;
  if (!url) return;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook responded ${res.status}: ${await res.text()}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Notify the team that a new PAMENG ticket has been analysed and needs a
 * human to review the suggested test instructions and create / update the
 * Autosana flow manually.
 */
export async function notifyFlowRecommendation(rec: FlowRecommendation): Promise<void> {
  if (!config.slackWebhookUrl) {
    logger.info(
      `Slack not configured — flow recommendation for ${rec.jiraKey} logged only`,
      { jiraKey: rec.jiraKey },
    );
    return;
  }

  const jiraUrl = `${config.jiraBaseUrl}/browse/${rec.jiraKey}`;

  // ── Action section ────────────────────────────────────────────────────────
  let actionText: string;
  if (rec.matchFound) {
    actionText =
      `*Existing flow to update:* "${rec.existingFlowName}" (${rec.existingFlowScore}% match)\n` +
      `*Suite:* ${rec.suiteName}\n` +
      `*Action:* Update the instructions for this flow in Autosana using the draft below.`;
  } else {
    actionText =
      `*Suggested flow name:* \`${rec.suggestedFlowName}\`\n` +
      `*Target suite:* ${rec.suiteName}\n` +
      `*Action:* Create a new flow in Autosana with the name and instructions below.`;
  }

  // Slack code blocks are capped at ~3000 chars before it gets unwieldy
  const instrPreview = rec.instructions.length > 2800
    ? rec.instructions.slice(0, 2800) + '\n…(truncated)'
    : rec.instructions;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🤖 PAM QA — Test Coverage Review Needed', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${jiraUrl}|${rec.jiraKey}>* — ${rec.jiraSummary}\n_Type: ${rec.issueType}_`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Why a test is needed:*\n${rec.gateReason}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: actionText },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Suggested test instructions:*\n\`\`\`${instrPreview}\`\`\``,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Once the flow is created/updated in Autosana, it will be triggered automatically when ${rec.jiraKey} moves to Dev or Stg.`,
        },
      ],
    },
  ];

  await post(blocks);
  logger.success(
    `Slack flow recommendation sent for ${rec.jiraKey}`,
    { jiraKey: rec.jiraKey, matchFound: rec.matchFound, suite: rec.suiteName },
  );
}
