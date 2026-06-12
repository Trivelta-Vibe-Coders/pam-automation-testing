/**
 * Generates a human-readable summary of test results
 * using Claude, for display in the Railway activity log.
 *
 * The summary covers:
 *  - which areas/flows were tested
 *  - how many passed/failed
 *  - the specific failure reason(s) from Autosana's run summaries
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface FailedFlowDetail {
  name:    string;
  summary: string;   // Autosana's failure description for this flow
}

export interface SuiteResult {
  suiteName:         string;
  passed:            number;
  failed:            number;
  failedFlowDetails?: FailedFlowDetail[];
}

export async function summariseTestResults(
  results: SuiteResult[],
  triggeredBy: string,
): Promise<string> {
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);

  // Build a structured breakdown: suite → flows tested → failures with reasons
  const lines: string[] = [];
  for (const r of results) {
    const totalFlows = r.passed + r.failed;
    lines.push(`Suite: ${r.suiteName} — ${totalFlows} flow(s) tested, ${r.passed} passed, ${r.failed} failed`);
    if (r.failedFlowDetails?.length) {
      for (const f of r.failedFlowDetails) {
        const reason = f.summary?.trim() ? `Reason: ${f.summary.trim()}` : 'Reason: unknown';
        lines.push(`  ✗ ${f.name} — ${reason}`);
      }
    }
  }

  const allPassed = totalFailed === 0;

  const prompt =
    `You are a concise QA reporter writing a brief update for a QA team.\n` +
    `Summarise the following test run in 2–3 sentences. Cover:\n` +
    (allPassed
      ? `  1. Which areas were tested and that everything passed.\n`
      : `  1. Which areas were tested.\n` +
        `  2. What failed and the specific reason(s) why (use the "Reason:" details).\n`) +
    `Be specific — name the failing flows and their error cause. Do not start with "I".\n\n` +
    `Ticket: ${triggeredBy}\n` +
    `Overall: ${totalPassed} passed, ${totalFailed} failed\n\n` +
    lines.join('\n');

  const message = await client.messages.create({
    model:      config.claudeModel,
    max_tokens: 200,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = message.content[0];
  return text.type === 'text' ? text.text.trim() : '';
}
