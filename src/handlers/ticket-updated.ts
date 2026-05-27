/**
 * Handler: jira:issue_updated
 *
 * Watches for status transitions to "Dev" or "Stg" (configurable).
 * On match:
 *   1. Look up stored flow link for this ticket
 *   2. If not found → run the full ticket-created pipeline first
 *      (find or create the Autosana flow, store the link)
 *   3. Trigger the relevant suite against the target environment
 *   4. Post Jira comment with batch_id so team can track the run
 */
import { JiraWebhookPayload } from '../types';
import * as logger from '../logger';
import * as jiraClient from '../services/jira';
import * as flowLinks from '../services/flow-links';
import { triggerFlows, TriggerEnvironment } from '../services/autosana-trigger';
import { startPolling } from '../services/batch-poller';
import { handleTicketCreated } from './ticket-created';
import { config } from '../config';

// Map Jira status names → Autosana environments
function statusToEnvironment(statusName: string): TriggerEnvironment | null {
  if (statusName === config.jiraStatusDev)          return 'dev';
  if (statusName === config.jiraStatusStg)          return 'staging';
  if (/^dev$/i.test(statusName))                    return 'dev';
  if (/^(stg|staging|stage)$/i.test(statusName))   return 'staging';
  return null;
}

export async function handleTicketUpdated(payload: JiraWebhookPayload): Promise<void> {
  const { issue, changelog } = payload;
  if (!changelog?.items?.length) return;

  const key = issue.key;

  // Look for a status change
  const statusChange = changelog.items.find(
    item => item.field === 'status' && item.toString !== null,
  );
  if (!statusChange) return; // non-status update (comment, field, etc.)

  const newStatus  = statusChange.toString!;
  const fromStatus = statusChange.fromString ?? '?';
  const env        = statusToEnvironment(newStatus);

  if (!env) {
    // Status changed but it's not a trigger-worthy status — log it so
    // the user can see what name came in and configure JIRA_STATUS_DEV /
    // JIRA_STATUS_STG if needed.
    logger.info(
      `${key} status changed to "${newStatus}" (not a trigger status — configure JIRA_STATUS_DEV or JIRA_STATUS_STG to enable)`,
      { key, fromStatus, toStatus: newStatus },
    );
    return;
  }

  logger.info(
    `${key} moved to "${newStatus}" → triggering ${env} run`,
    { key, fromStatus, toStatus: newStatus },
  );

  // 1. Look up stored flow link
  let link = flowLinks.getLink(key);

  if (link) {
    logger.info(`Found stored flow link for ${key}: "${link.flowName}"`, {
      flowId:  link.flowId,
      suiteId: link.suiteId,
    });
  } else {
    // 2. No stored link — run the full ticket-created pipeline:
    //    finds or creates the Autosana flow and stores the link
    logger.info(
      `No flow setup found for ${key} — running full ticket setup before triggering`,
      { key },
    );
    await handleTicketCreated(issue);

    // Re-read; handleTicketCreated will have stored it if successful
    link = flowLinks.getLink(key);
    if (!link) {
      logger.warn(`Flow setup completed but no link stored for ${key} — triggering all PAM suites`);
    }
  }

  const suiteIds = link ? [link.suiteId] : undefined;

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
    } catch { /* ignore */ }
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
