/**
 * Handler: jira:issue_created
 *
 * Workflow:
 * 1. Extract ticket context (summary, description as plain text, labels, components)
 * 2. Fetch all existing PAM flows
 * 3. Run semantic matching via Claude (≥70% threshold)
 *    - Match found  → augment that flow's instructions + update flow in Autosana
 *    - No match     → detect suite + generate new instructions + create flow
 * 4. Store jiraKey → flowId in flow-links store
 * 5. Post Jira comment linking to the Autosana flow
 */
import { JiraIssue } from '../types';
import * as logger from '../logger';
import * as autosana from '../services/autosana';
import * as jiraClient from '../services/jira';
import * as matcher from '../services/flow-matcher';
import * as flowLinks from '../services/flow-links';
import { config } from '../config';

export async function handleTicketCreated(issue: JiraIssue): Promise<void> {
  const { key } = issue;
  const fields   = issue.fields;

  logger.info(`Ticket created: ${key} — "${fields.summary}"`);

  // 1. Build ticket context
  const ticket: matcher.TicketContext = {
    key,
    summary:    fields.summary,
    description: matcher.adfToPlainText(fields.description ?? undefined),
    labels:     fields.labels ?? [],
    components: (fields.components ?? []).map(c => c.name),
    issueType:  fields.issuetype?.name ?? 'Story',
    priority:   fields.priority?.name  ?? 'Medium',
  };

  // 2. Gate: does this ticket need an automated test?
  let gate: Awaited<ReturnType<typeof matcher.shouldCreateTest>>;
  try {
    gate = await matcher.shouldCreateTest(ticket);
  } catch (err) {
    logger.warn(`Test-coverage gate failed for ${key} — defaulting to create`, { error: String(err) });
    gate = { needed: true, reason: 'Gate check error — defaulting to create' };
  }

  if (!gate.needed) {
    logger.info(
      `${key} — no test coverage required: ${gate.reason}`,
      { key, reason: gate.reason },
    );
    try {
      await jiraClient.addComment(
        key,
        `🤖 *PAM QA Agent* — No automated test flow needed for this ticket.\n` +
        `Reason: ${gate.reason}\n\n` +
        `_If test coverage is required, add the label \`pam-test\` and the agent will create a flow._`,
      );
    } catch { /* ignore comment errors */ }
    return;
  }

  logger.info(`${key} — test coverage required: ${gate.reason}`, { key, reason: gate.reason });

  // 4. Fetch all PAM flows
  let allFlows: Awaited<ReturnType<typeof autosana.listAllPamFlows>>;
  try {
    allFlows = await autosana.listAllPamFlows();
    logger.info(`Fetched ${allFlows.length} existing flow(s) from Autosana`);
  } catch (err) {
    logger.error(`Failed to fetch Autosana flows for ${key}`, { error: String(err) });
    return;
  }

  // 5. Semantic matching
  let targetFlowId: string;
  let targetFlowName: string;
  let targetSuiteId: string;
  let action: 'updated' | 'created';

  try {
    const matches = await matcher.matchFlows(ticket, allFlows);
    const bestMatch = matches[0];

    if (bestMatch && bestMatch.score >= config.matchThreshold) {
      // ── Update existing flow ──────────────────────────────────────────────
      logger.info(
        `Match found for ${key}: "${bestMatch.flow.name}" (score ${bestMatch.score}%)`,
        { reason: bestMatch.reason },
      );

      const augmented = await matcher.augmentFlowInstructions(
        bestMatch.flow.instructions,
        ticket,
      );

      await autosana.updateFlow(bestMatch.flow.id, { instructions: augmented });

      targetFlowId   = bestMatch.flow.id;
      targetFlowName = bestMatch.flow.name;
      targetSuiteId  = bestMatch.flow.suite_id;
      action         = 'updated';

      logger.success(
        `Flow "${targetFlowName}" updated to cover ${key}`,
        {
          flowId:       targetFlowId,
          autosanaUrl:  `${config.autosanaAppUrl}/suites/${targetSuiteId}`,
        },
      );
    } else {
      // ── Create new flow ───────────────────────────────────────────────────
      logger.info(
        bestMatch
          ? `Best match "${bestMatch.flow.name}" scored ${bestMatch.score}% (below ${config.matchThreshold}% threshold) — creating new flow`
          : `No existing flows matched — creating new flow`,
      );

      const suiteName  = await matcher.detectSuite(ticket);
      const suiteId    = config.suites[suiteName] ?? Object.values(config.suites)[0];
      const instructions = await matcher.generateFlowInstructions(ticket);
      const flowName     = `${key}: ${fields.summary}`.slice(0, 100);

      const newFlow = await autosana.createFlow({
        name:         flowName,
        instructions,
        suite_id:     suiteId,
      });

      targetFlowId   = newFlow.id;
      targetFlowName = newFlow.name;
      targetSuiteId  = suiteId;
      action         = 'created';

      logger.success(
        `New flow "${targetFlowName}" created in suite "${suiteName}"`,
        {
          flowId:      targetFlowId,
          suiteId,
          autosanaUrl: `${config.autosanaAppUrl}/suites/${suiteId}`,
        },
      );
    }
  } catch (err) {
    logger.error(`Flow match/create failed for ${key}`, { error: String(err) });
    return;
  }

  // 6. Persist the link
  flowLinks.setLink({
    jiraKey:   key,
    flowId:    targetFlowId,
    flowName:  targetFlowName,
    suiteId:   targetSuiteId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // 7. Post Jira comment
  try {
    const verb = action === 'updated' ? 'updated to include coverage for' : 'created for';
    await jiraClient.addComment(
      key,
      `🤖 *PAM QA Agent* — Autosana flow ${verb} this ticket.\n` +
      `Flow: "${targetFlowName}"\n` +
      `This flow will be triggered automatically when the ticket moves to Dev or Stg.`,
    );
  } catch (err) {
    logger.warn(`Could not post Jira comment on ${key}`, { error: String(err) });
  }
}
