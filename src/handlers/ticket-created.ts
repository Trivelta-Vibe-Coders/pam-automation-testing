/**
 * Handler: jira:issue_created
 *
 * Workflow:
 * 1. Build ticket context
 * 2. Gate: does this ticket need automated test coverage?
 *    No  → post Jira comment explaining why, done
 *    Yes → continue
 * 3. Fetch existing PAM flows from Autosana
 * 4. Semantic matching via Claude
 *    Match ≥ threshold → generate augmented instructions for the existing flow
 *    No match          → detect best suite + generate fresh instructions
 * 5. Send Slack notification with the recommendation (no flow is created here)
 * 6. Post Jira comment confirming analysis was sent
 *
 * NOTE: Flow creation / updates are intentionally NOT performed automatically.
 *       A human reviews the Slack recommendation and creates/updates the flow
 *       manually in Autosana.  Once the flow exists, it can be linked via the
 *       flow-links store and will be triggered on Dev/Stg transitions as normal.
 */
import { JiraIssue } from '../types';
import * as logger from '../logger';
import * as autosana from '../services/autosana';
import * as matcher from '../services/flow-matcher';
import * as slack from '../services/slack';
import * as ticketStore from '../services/ticket-store';
import * as jiraClient from '../services/jira';
import { extractSprintName, isSprintActive, extractEpicRef } from '../services/jira-fields';
import { config } from '../config';

// ── Dedup guard ───────────────────────────────────────────────────────────────
// Jira re-delivers issue_created webhooks when a connection drops mid-flight.
// Each re-delivery would run the full AI pipeline and produce near-identical
// but not-quite-identical log messages (Claude text varies), bypassing the
// per-event minute-bucket dedup in ticket-store.ts.
//
// Two-layer guard (no time-sensitivity):
//  1. Persistent store check — if the ticket already has stored events we've
//     processed it before, even across server restarts. Always skip.
//  2. In-flight set — prevents two concurrent deliveries both passing check 1
//     before either has finished writing its first event to the store.

const inFlight = new Set<string>();

export async function handleTicketCreated(issue: JiraIssue): Promise<void> {
  const { key } = issue;
  const fields   = issue.fields;

  // Guard 1: persistent — already processed (survives restarts)
  if (ticketStore.getTicket(key)?.events.length) {
    console.log(`[ticket-created] ${key} already has stored events — skipping duplicate issue_created`);
    return;
  }

  // Guard 2: in-flight — concurrent delivery arrived before Guard 1 could fire
  if (inFlight.has(key)) {
    console.log(`[ticket-created] ${key} already in-flight — skipping concurrent duplicate`);
    return;
  }

  inFlight.add(key);
  try {

  logger.info(`Ticket created: ${key} — "${fields.summary}"`);

  // 1. Build ticket context
  const ticket: matcher.TicketContext = {
    key,
    summary:     fields.summary,
    description: matcher.adfToPlainText(fields.description ?? undefined),
    labels:      fields.labels ?? [],
    components:  (fields.components ?? []).map(c => c.name),
    issueType:   fields.issuetype?.name ?? 'Story',
    priority:    fields.priority?.name  ?? 'Medium',
  };

  // 1b. Persist initial Jira status + sprint / epic so the UI can show them
  ticketStore.updateTicketStatus(key, fields.status.name);
  const epicRef = extractEpicRef(fields);
  ticketStore.updateTicketMeta(key, {
    sprint:         extractSprintName(fields),
    sprintIsActive: isSprintActive(fields),
    epic:           epicRef,
  });
  // Fetch the epic's own Jira status so the UI can filter to in-progress epics only
  if (epicRef) {
    jiraClient.getIssue(epicRef)
      .then(epicIssue => ticketStore.updateTicketMeta(key, { epicStatus: epicIssue.fields.status.name }))
      .catch(() => { /* non-fatal — backfill will retry on next startup */ });
  }

  // 2. Gate: check manual override first, then AI gate
  if (ticketStore.getTicket(key)?.noTestNeeded) {
    logger.info(`${key} — manually marked as no test needed — skipping`, { key });
    return;
  }

  // 2b. AI gate: does this ticket need an automated test?
  let gate: Awaited<ReturnType<typeof matcher.shouldCreateTest>>;
  try {
    gate = await matcher.shouldCreateTest(ticket);
  } catch (err) {
    logger.warn(`Test-coverage gate failed for ${key} — defaulting to notify`, { error: String(err) });
    gate = { needed: true, reason: 'Gate check error — defaulting to notify' };
  }

  if (!gate.needed) {
    logger.info(
      `${key} — no test coverage required: ${gate.reason}`,
      { key, reason: gate.reason },
    );
    return;
  }

  logger.info(`${key} — test coverage required: ${gate.reason}`, { key, reason: gate.reason });

  // 3. Fetch all PAM flows
  let allFlows: Awaited<ReturnType<typeof autosana.listAllPamFlows>>;
  try {
    allFlows = await autosana.listAllPamFlows();
    logger.info(`Fetched ${allFlows.length} existing flow(s) from Autosana`);
  } catch (err) {
    logger.error(`Failed to fetch Autosana flows for ${key}`, { error: String(err) });
    return;
  }

  // 4. Semantic matching + instruction generation
  let matchFound      = false;
  let existingFlowName:  string | undefined;
  let existingFlowScore: number | undefined;
  let suggestedFlowName: string | undefined;
  let suiteName       = '';
  let instructions    = '';

  try {
    const matches  = await matcher.matchFlows(ticket, allFlows);
    const bestMatch = matches[0];

    if (bestMatch && bestMatch.score >= config.matchThreshold) {
      // Existing flow is a good match — suggest updated instructions
      logger.info(
        `Match found for ${key}: "${bestMatch.flow.name}" (score ${bestMatch.score}%)`,
        { reason: bestMatch.reason },
      );

      instructions       = await matcher.augmentFlowInstructions(bestMatch.flow.instructions, ticket);
      matchFound         = true;
      existingFlowName   = bestMatch.flow.name;
      existingFlowScore  = bestMatch.score;
      suiteName          = Object.entries(config.suites)
        .find(([, id]) => id === bestMatch.flow.suite_id)?.[0] ?? 'Unknown Suite';

      logger.success(
        `Instructions drafted for existing flow "${existingFlowName}" — recommendation pending`,
        { flowId: bestMatch.flow.id, key },
      );
    } else {
      // No match — suggest a brand-new flow
      logger.info(
        bestMatch
          ? `Best match "${bestMatch.flow.name}" scored ${bestMatch.score}% (below threshold) — drafting new flow`
          : `No existing flows matched — drafting new flow`,
      );

      suiteName          = await matcher.detectSuite(ticket);
      instructions       = await matcher.generateFlowInstructions(ticket);
      suggestedFlowName  = `${key}: ${fields.summary}`.slice(0, 100);

      logger.success(
        `Instructions drafted for new flow in suite "${suiteName}" — recommendation pending`,
        { suggestedFlowName, suiteName, key },
      );
    }
  } catch (err) {
    logger.error(`Flow analysis failed for ${key}`, { error: String(err), key });
    return;
  }

  // 5. Ping the team via Slack
  try {
    await slack.notifyFlowRecommendation({
      jiraKey:           key,
      jiraSummary:       fields.summary,
      issueType:         ticket.issueType,
      gateReason:        gate.reason,
      matchFound,
      existingFlowName,
      existingFlowScore,
      suggestedFlowName,
      suiteName,
      instructions,
    });
  } catch (err) {
    logger.warn(`Could not send Slack recommendation for ${key}`, { error: String(err), key });
  }

  } finally {
    inFlight.delete(key);
  }
}
