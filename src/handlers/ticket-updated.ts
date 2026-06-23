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
import * as ticketStore from '../services/ticket-store';
import * as envRestrictions from '../services/env-restrictions';
import * as bugLinksStore from '../services/bug-links';
import { triggerFlows, TriggerEnvironment } from '../services/autosana-trigger';
import { startPolling } from '../services/batch-poller';
import { extractSprintName, isSprintActive, extractEpicRef } from '../services/jira-fields';
import { config } from '../config';

// ── Webhook duplicate guard ────────────────────────────────────────────────────
// Jira frequently re-delivers the same webhook multiple times. This cache
// tracks recent status transitions (key:status → expiry timestamp) so we can
// skip duplicate trigger runs within a 2-minute window.
const DEDUP_TTL_MS = 2 * 60 * 1000; // 2 minutes
const recentTransitions = new Map<string, number>();

function checkAndMarkTransition(key: string, status: string): boolean {
  const cacheKey = `${key}:${status}`;
  const expiry = recentTransitions.get(cacheKey);
  const now = Date.now();
  if (expiry !== undefined && now < expiry) return false; // duplicate — skip
  recentTransitions.set(cacheKey, now + DEDUP_TTL_MS);
  // Prune stale entries to avoid unbounded growth
  if (recentTransitions.size > 500) {
    for (const [k, exp] of recentTransitions) {
      if (now > exp) recentTransitions.delete(k);
    }
  }
  return true; // first occurrence within window — proceed
}

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

  // Always persist the latest Jira status + sprint/epic metadata
  ticketStore.updateTicketStatus(key, newStatus);
  const epicRef = extractEpicRef(issue.fields);
  ticketStore.updateTicketMeta(key, {
    sprint:         extractSprintName(issue.fields),
    sprintIsActive: isSprintActive(issue.fields),
    epic:           epicRef,
  });
  // Fetch the epic's own Jira status so the UI can filter to in-progress epics only
  if (epicRef) {
    jiraClient.getIssue(epicRef)
      .then(epicIssue => ticketStore.updateTicketMeta(key, { epicStatus: epicIssue.fields.status.name }))
      .catch(() => { /* non-fatal */ });
  }

  // ── Dedup guard ──────────────────────────────────────────────────────────────
  // Skip the trigger logic if this is a repeat delivery of the same transition.
  // Metadata updates above are idempotent so we let them run even for duplicates.
  if (!checkAndMarkTransition(key, newStatus)) {
    logger.info(`Skipping duplicate webhook for ${key} → "${newStatus}"`, { key });
    return;
  }

  const env    = statusToEnvironment(newStatus);
  const isDone = newStatus === config.jiraStatusDone || /^done$/i.test(newStatus);

  if (!env && !isDone) {
    logger.info(
      `${key} status changed to "${newStatus}" (not a trigger status — configure JIRA_STATUS_DEV or JIRA_STATUS_STG to enable)`,
      { key, fromStatus, toStatus: newStatus },
    );
    return;
  }

  // ── Bug link trigger ──────────────────────────────────────────────────────────
  // If this ticket is a bug fix for a parent ticket, re-run the parent's linked
  // flows in the environment matching the new status. This runs before the
  // noTestNeeded check because that flag applies to the ticket's own flows, not
  // to its role as a bug fix proxy for another ticket.
  const bugLink = bugLinksStore.getBugLink(key);
  if (bugLink && env) {
    const { parentKey } = bugLink;
    const parentLink = flowLinks.getLink(parentKey);
    if (parentLink?.flows.length) {
      try {
        const bugResult = await triggerFlows({
          environment: env,
          flowIds:     parentLink.flows.map(f => f.flowId),
          jiraKey:     parentKey,
        });
        startPolling({ batchId: bugResult.batchId, environment: env, triggeredBy: parentKey });
        // Log on the bug ticket's card
        logger.success(
          `${key} moved to "${newStatus}" — triggered re-run of ${parentKey} tests in ${env}`,
          { key, parentKey, batchId: bugResult.batchId },
        );
        // Log on the parent ticket's card
        logger.success(
          `Re-run triggered by bug fix ${key} moving to "${newStatus}"`,
          { key: parentKey, triggeredBy: key, batchId: bugResult.batchId },
        );
      } catch (err) {
        logger.error(
          `Bug-fix re-run failed for ${parentKey} (triggered by ${key})`,
          { error: String(err), key: parentKey },
        );
      }
    } else {
      logger.info(
        `${key} is a bug fix for ${parentKey} — ${parentKey} has no linked flows, skipping re-run`,
        { key, parentKey },
      );
    }
    // If this ticket has no flows of its own, nothing else to do
    if (!flowLinks.getLink(key)) return;
  }

  // Respect manual "no test needed" override
  if (ticketStore.getTicket(key)?.noTestNeeded) {
    logger.info(
      `${key} moved to "${newStatus}" but is marked as no test needed — skipping trigger`,
      { key, toStatus: newStatus },
    );
    return;
  }

  // ── Production trigger on Done ─────────────────────────────────────────────
  if (isDone) {
    const link = flowLinks.getLink(key);
    if (!link) {
      logger.info(`${key} moved to Done — no flow links, skipping production trigger`, { key });
      return;
    }

    // Only trigger flows marked Prod only (excluded from both dev and staging)
    const prodOnlyFlowIds = link.flows
      .map(f => f.flowId)
      .filter(id =>
        envRestrictions.isExcluded(id, 'dev') &&
        envRestrictions.isExcluded(id, 'staging'),
      );

    if (!prodOnlyFlowIds.length) {
      logger.info(
        `${key} moved to Done — no prod-only flows linked, skipping production trigger`,
        { key },
      );
      return;
    }

    const prodNames = link.flows
      .filter(f => prodOnlyFlowIds.includes(f.flowId))
      .map(f => `"${f.flowName}"`).join(', ');
    logger.info(
      `${key} moved to Done → triggering ${prodOnlyFlowIds.length} prod-only flow(s): ${prodNames}`,
      { key, flowIds: prodOnlyFlowIds },
    );

    let prodResult: Awaited<ReturnType<typeof triggerFlows>>;
    try {
      prodResult = await triggerFlows({
        environment: 'production',
        flowIds:     prodOnlyFlowIds,
        jiraKey:     key,
      });
    } catch (err) {
      logger.error(`Production trigger failed for ${key}`, { error: String(err) });
      return;
    }

    startPolling({ batchId: prodResult.batchId, environment: 'production', triggeredBy: key });
    return;
  }

  // env is guaranteed non-null here (isDone handled above, null env returned early)
  const safeEnv = env!;

  logger.info(
    `${key} moved to "${newStatus}" → triggering ${safeEnv} run`,
    { key, fromStatus, toStatus: newStatus },
  );

  // 1. Look up stored flow link
  let link = flowLinks.getLink(key);

  if (!link) {
    logger.info(
      `${key} moved to "${newStatus}" — no flow links found, skipping (link a flow via the Flow Links panel to enable automated testing)`,
      { key, toStatus: newStatus },
    );
    return;
  }

  const names = link.flows.map(f => `"${f.flowName}"`).join(', ');
  logger.info(`Found ${link.flows.length} linked flow(s) for ${key}: ${names}`, {
    flowIds: link.flows.map(f => f.flowId),
  });

  // 3. Trigger linked flows
  let result: Awaited<ReturnType<typeof triggerFlows>>;
  try {
    result = await triggerFlows({
      environment: safeEnv,
      flowIds:     link.flows.map(f => f.flowId),
      jiraKey:     key,
    });
  } catch (err) {
    logger.error(`Trigger failed for ${key}`, { error: String(err) });
    try {
      await jiraClient.addComment(
        key,
        `🤖 *PAM QA Agent* — Failed to trigger automated tests for the ${safeEnv} environment.\n` +
        `Error: ${String(err).slice(0, 200)}\n` +
        `Please trigger manually via GitHub Actions.`,
      );
    } catch { /* ignore */ }
    return;
  }

  // 4. Start background polling → Slack report when complete
  startPolling({ batchId: result.batchId, environment: safeEnv, triggeredBy: key });

  // 5. Post Jira comment
  try {
    const whatRan = link.flows.length === 1
      ? `Flow: "${link.flows[0].flowName}"`
      : `Flows: ${link.flows.map(f => `"${f.flowName}"`).join(', ')}`;

    await jiraClient.addComment(
      key,
      `🤖 *PAM QA Agent* — Automated tests triggered for *${safeEnv}* environment.\n` +
      `${whatRan}\n` +
      `Batch ID: \`${result.batchId}\`  |  Flows: ${result.flowRunCount}\n` +
      `Results will appear in Slack once the run completes (~15–30 min).`,
    );
    logger.success(`Jira comment posted on ${key}`, { batchId: result.batchId });
  } catch (err) {
    logger.warn(`Could not post Jira comment on ${key}`, { error: String(err) });
  }
}
