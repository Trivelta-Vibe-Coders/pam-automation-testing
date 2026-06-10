/**
 * Generates a human-readable one-sentence summary of test results
 * using Claude, for display in the Railway activity log.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface SuiteResult {
  suiteName: string;
  passed:    number;
  failed:    number;
  failedFlowNames?: string[];
}

export async function summariseTestResults(
  results: SuiteResult[],
  triggeredBy: string,
): Promise<string> {
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);

  // Build a compact text description for the prompt
  const lines = results.map(r => {
    const base = `${r.suiteName}: ${r.passed} passed, ${r.failed} failed`;
    if (r.failedFlowNames?.length) {
      return base + ` (failed flows: ${r.failedFlowNames.join(', ')})`;
    }
    return base;
  });

  const prompt =
    `You are a concise QA reporter. Summarise these test results in ONE sentence ` +
    `(max 25 words). Be specific about which areas failed if any. Do not start with "I".` +
    `\n\nTicket: ${triggeredBy}\nTotal: ${totalPassed} passed, ${totalFailed} failed\n` +
    lines.join('\n');

  const message = await client.messages.create({
    model:      config.claudeModel,
    max_tokens: 80,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = message.content[0];
  return text.type === 'text' ? text.text.trim() : '';
}
