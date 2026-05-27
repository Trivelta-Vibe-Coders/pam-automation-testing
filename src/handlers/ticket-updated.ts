/**
 * Handler: jira:issue_updated
 *
 * Watches for status transitions to "Dev" or "Stg" (configurable).
 * On match:
 *   1. Look up stored flow link for this ticket
 *   2. If found → trigger that specific flow's suite against the target environment
 *   3. If not found → fallback: run semantic match against all flows, trigger best match
 *   4. Post Jira comment with batch_id so team can track the run
 */
import { JiraWebhookPayload } from '../types';
import * as logger from '../logger';
import * as jiraClient from '../services/jira';
import * as autosana from '../services/autosana';
import * as matcher from '../services/flow-matcher';
import * as flowLinks from '../services/flow-links';
import { triggerFlows, TriggerEnvironment } from '../services/autosana-trigger';
import { startPolling } from '../services/batch-poller';
import { config } from '../config';

// Map Jira status names → Autosana environments
function statusToEnvironment(statusName: string): TriggerEnvironment | null {
  if (statusName === config.jiraStatusDev)                         return 'dev';
  if (statusName === config.jiraStatusStg)                         return 'staging';
  // fuzzy fallbacks
  if (/^dev$/i.test(statusName))                                   return 'dev';
  if (/^(stg|staging|stage)$/i.test(statusName))                  return 'staging';
  return null;
}

export async function handleTicketUpdated(payload: JiraWebhookPayload): Promise<void> {
  const { issue, changelog } = payload;
  if (!changelog?.items?.length) return;

  const key    = issue.key;
  const fields = issue.fields;

  // Look for a status change
  const statusChange = changelog.items.find(
    item => item.field === 'status' && item.toString !== null,
  );
  if (!statusChange) return;

  const newStatus = statusChange.toString!;
  const env       = statusToEnvironment(newStatus);

  if (!env) {
    // Not a trigger-worthy status change — ignore silently
    return;
  }

  logger.info(
    `${key} moved to "${newStatus}" → triggering ${env} run`,
    { key, fromStatus: statusChange.fromString, toStatus: newStatus },
  );

  // 1. Look up stored link
  const link = flowLinks.getLink(key);
  let suiteIds: string[] | undefined;

  if (link) {
    logger.info(`Found stored flow link for ${key}: "${link.flowName}"`, {
      flowId:  link.flowId,
      suiteId: link.suiteId,
    });
    // Trigger just the relevant suite
    suiteIds = [link.suiteId];
  } else {
    // 2. Fallback: semantic match
    logger.warn(`No stored flow link for ${key} — running semantic match`);
    try {
      const ticket: matcher.TicketContext = {
        key,
        summary:     fields.summary,
        description: matcher.adfToPlainText(fields.description ?? undefined),
        labels:      fields.labels ?? [],
        components:  (fields.components ?? []).map(c => c.name),
        issueType:   fields.issuetype?.name ?? 'Story',
        priority:    fields.priority?.name  ?? 'Medium',
      };
      const allFlows = await autosana.listAllPamFlows();
      const matches  = await matcher.matchFlows(ticket, allFlows);
      const best     = matches[0];

      if (best && best.score >= config.matchThreshold) {
        suiteIds = [best.flow.suite_id];
        logger.info(
          `Fallback match: "${best.flow.name}" (score ${best.score}%) → triggering suite`,
          { flowId: best.flow.id, suiteId: best.flow.suite_id },
        );
        // Store link for future transitions
        flowLinks.setLink({
          jiraKey:   key,
          flowId:    best.flow.id,
          flowName:  best.flow.name,
          suiteId:   best.flow.suite_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } else {
        logger.warn(
          `No high-confidence flow match for ${key} — triggering all PAM suites as fallback`,
        );
        // suiteIds stays undefined → triggerFlows will use all suites
      }
    } catch (err) {
      logger.error(`Semantic match fallback failed for ${key}`, { error: String(err) });
      // Still proceed with full-suite trigger rather than silently failing
    }
  }

  // 3. Trigger
  let result: Awaited<ReturnType<typeof triggerFlows>>;
  try {
    result = await triggerFlows({ environment: env, suiteIds, jiraKey: key });
  } catch (err) {
    logger.error(`Trigger failed for ${key}`, { error: String(err) });
    try {
      await jiraClient.addComment(
        key,
        `🤖 *PAM QA Agent* — Failed to trigger automated tests for the ${env} environment.\n` +
        `Error: ${String(err).slice(0, 200)}\n` +
        `Please trigger manually via GitHub Actions.`,
      );
    } catch { /* ignore comment failure */ }
    return;
  }

  // 4. Start background polling → Slack report when complete
  startPolling({ batchId: result.batchId, environment: env, triggeredBy: key });

  // 5. Post Jira comment
  try {
    const suitesRun = suiteIds
      ? Object.entries(config.suites)
          .filter(([, id]) => suiteIds!.includes(id))
          .map(([name]) => name)
          .join(', ')
      : 'all PAM suites';

    await jiraClient.addComment(
      key,
      `🤖 *PAM QA Agent* — Automated tests triggered for *${env}* environment.\n` +
      `Suite(s): ${suitesRun}\n` +
      `Batch ID: \`${result.batchId}\`  |  Flows: ${result.flowRunCount}\n` +
      `Results will appear in Slack once the run completes (~15–30 min).`,
    );
    logger.success(`Jira comment posted on ${key}`, { batchId: result.batchId });
  } catch (err) {
    logger.warn(`Could not post Jira comment on ${key}`, { error: String(err) });
  }
}
