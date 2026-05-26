/**
 * Semantic flow-to-ticket matching and flow generation using Claude.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { AutosanaFlow, FlowMatch, AdfDocument, AdfNode } from '../types';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// ── ADF → plain text ──────────────────────────────────────────────────────────

function adfNodeToText(node: AdfNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (!node.content) return '';
  const childText = node.content.map(adfNodeToText).join('');
  if (node.type === 'paragraph' || node.type === 'heading') return childText + '\n';
  if (node.type === 'listItem') return '• ' + childText;
  if (node.type === 'bulletList' || node.type === 'orderedList') return childText + '\n';
  if (node.type === 'codeBlock') return '```\n' + childText + '\n```\n';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'rule') return '---\n';
  return childText;
}

export function adfToPlainText(doc: AdfDocument | null | undefined): string {
  if (!doc) return '';
  return doc.content?.map(adfNodeToText).join('').trim() ?? '';
}

// ── Ticket → string ───────────────────────────────────────────────────────────

export interface TicketContext {
  key: string;
  summary: string;
  description: string;   // plain text already
  labels: string[];
  components: string[];
  issueType: string;
  priority: string;
}

// ── Match existing flows ──────────────────────────────────────────────────────

/**
 * Ask Claude to score each existing flow against the ticket.
 * Returns matches sorted by score descending.
 */
export async function matchFlows(
  ticket: TicketContext,
  flows: AutosanaFlow[],
): Promise<FlowMatch[]> {
  if (flows.length === 0) return [];

  const flowList = flows
    .map((f, i) => `[${i}] id=${f.id}\nname: ${f.name}\ninstructions: ${f.instructions.slice(0, 300)}`)
    .join('\n\n');

  const prompt = `You are a QA coverage analyst. Given a Jira ticket and a list of automation flows, score how well each flow already covers the ticket's feature (0–100).

A score ≥ 70 means the flow adequately covers the feature and only needs minor instruction updates.
A score < 70 means the flow does not adequately cover the feature.

JIRA TICKET
Key: ${ticket.key}
Type: ${ticket.issueType}
Summary: ${ticket.summary}
Labels: ${ticket.labels.join(', ') || 'none'}
Components: ${ticket.components.join(', ') || 'none'}
Description:
${ticket.description || '(no description)'}

EXISTING FLOWS
${flowList}

Return ONLY valid JSON (no markdown, no explanation):
{"matches":[{"flow_id":"...","score":75,"reason":"one sentence"}]}

Include only flows with score > 0. If no flows are relevant, return {"matches":[]}.`;

  const msg = await anthropic.messages.create({
    model:      config.claudeModel,
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();

  let parsed: { matches: Array<{ flow_id: string; score: number; reason: string }> };
  try {
    // Strip markdown code fences if present
    const json = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Claude returned invalid JSON for flow matching: ${raw.slice(0, 200)}`);
  }

  const flowById = new Map(flows.map(f => [f.id, f]));
  return (parsed.matches ?? [])
    .filter(m => flowById.has(m.flow_id))
    .map(m => ({ flow: flowById.get(m.flow_id)!, score: m.score, reason: m.reason }))
    .sort((a, b) => b.score - a.score);
}

// ── Determine target suite ────────────────────────────────────────────────────

const SUITE_NAMES = [
  'PAM Affiliates',
  'PAM Users Tab',
  'PAM Casino Reports',
  'PAM Agent Audit Log',
] as const;

/**
 * Ask Claude which PAM suite best fits this ticket.
 * Returns one of the four suite names.
 */
export async function detectSuite(ticket: TicketContext): Promise<string> {
  const prompt = `You are a QA architect. Classify this Jira ticket into exactly one Autosana test suite.

SUITES:
- PAM Affiliates     — affiliate management, revenue share, partner portals
- PAM Users Tab      — user accounts, profile management, bet history, sports bets, casino bets, transactions
- PAM Casino Reports — casino reporting, sort/filter, data exports, KPIs, analytics
- PAM Agent Audit Log — agent activity logs, audit trails, admin actions

TICKET
Key: ${ticket.key}
Summary: ${ticket.summary}
Labels: ${ticket.labels.join(', ') || 'none'}
Components: ${ticket.components.join(', ') || 'none'}
Description (truncated):
${ticket.description.slice(0, 400) || '(none)'}

Return ONLY the suite name, exactly as listed above (no quotes, no explanation).`;

  const msg = await anthropic.messages.create({
    model:      config.claudeModel,
    max_tokens: 64,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw = (msg.content[0] as { type: string; text: string }).text.trim();
  const match = SUITE_NAMES.find(s => raw.includes(s));
  return match ?? 'PAM Users Tab';   // fallback
}

// ── Generate flow instructions ────────────────────────────────────────────────

/**
 * Generate clear test flow instructions from a Jira ticket.
 * Returns plain-English steps an AI test agent can follow.
 */
export async function generateFlowInstructions(ticket: TicketContext): Promise<string> {
  const prompt = `You are a senior QA engineer writing automated test instructions for an AI test agent.

Given this Jira ticket, write a clear, step-by-step test flow that verifies the described feature works correctly.

Guidelines:
- Write from the perspective of a QA tester navigating the PAM (Player Account Management) back-office web app
- Each step should be a concrete action (navigate, click, enter, verify, assert)
- Include both happy-path and the key edge case from the ticket
- Keep it under 20 steps
- Do NOT include setup/teardown (login is handled by the suite)

JIRA TICKET
Key: ${ticket.key}
Summary: ${ticket.summary}
Labels: ${ticket.labels.join(', ') || 'none'}
Components: ${ticket.components.join(', ') || 'none'}
Description:
${ticket.description || '(no description provided)'}

Return ONLY the plain-text step-by-step instructions. No headers, no markdown, no JSON.`;

  const msg = await anthropic.messages.create({
    model:      config.claudeModel,
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  return (msg.content[0] as { type: string; text: string }).text.trim();
}

// ── Augment existing flow instructions ───────────────────────────────────────

/**
 * Ask Claude to revise existing flow instructions to also cover the new ticket.
 */
export async function augmentFlowInstructions(
  existing: string,
  ticket: TicketContext,
): Promise<string> {
  const prompt = `You are a senior QA engineer. An existing Autosana test flow needs to be updated to also cover a new Jira ticket.

EXISTING INSTRUCTIONS:
${existing}

NEW JIRA TICKET TO COVER:
Key: ${ticket.key}
Summary: ${ticket.summary}
Description:
${ticket.description.slice(0, 600) || '(no description)'}

Update the instructions to incorporate test coverage for the new ticket without breaking existing coverage.
Keep the total under 25 steps.
Return ONLY the updated plain-text instructions. No headers, no markdown, no JSON.`;

  const msg = await anthropic.messages.create({
    model:      config.claudeModel,
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  return (msg.content[0] as { type: string; text: string }).text.trim();
}
