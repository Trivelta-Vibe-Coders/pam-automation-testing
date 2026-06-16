/**
 * Startup backfill: fetch sprint/epic from Jira for any stored ticket that
 * is missing that metadata (i.e. tickets processed before this feature existed).
 * Also fetches the Jira status of each unique epic so the UI can filter to
 * "in progress" epics only.
 *
 * Runs once in the background after the server starts — failures are logged
 * but never fatal.  A 300 ms delay between requests avoids hammering Jira.
 */
import * as ticketStore from './ticket-store';
import * as jiraClient  from './jira';
import { extractSprintName, isSprintActive, extractEpicRef } from './jira-fields';
import * as logger from '../logger';
import { config } from '../config';

export async function backfillTicketMeta(): Promise<void> {
  // ── Pass 0: refresh sprint data for all tickets in open sprints ──────────────
  // Tickets moved between sprints via bulk operations or sprint start/close don't
  // always fire individual webhooks, so stored sprint names can go stale.
  // One JQL call covers all of them efficiently.
  try {
    const openSprintIssues = await jiraClient.searchIssues(
      `project = ${config.jiraProject} AND sprint in openSprints() ORDER BY updated DESC`,
      ['summary', 'status', 'customfield_10020'],
      500,
    );
    let refreshed = 0;
    for (const issue of openSprintIssues) {
      const sprint         = extractSprintName(issue.fields);
      const sprintIsActive = isSprintActive(issue.fields);
      if (sprint && ticketStore.getTicket(issue.key)) {
        ticketStore.updateTicketMeta(issue.key, { sprint, sprintIsActive });
        refreshed++;
      }
    }
    if (refreshed > 0) {
      logger.info(`Sprint refresh: updated ${refreshed} stored ticket(s) to current active sprint`);
    }
  } catch (err) {
    // Non-fatal — stale sprint data is cosmetic, don't block the rest of backfill
    logger.warn('Sprint refresh (pass 0) failed — using stored data', { error: String(err) });
  }

  // ── Pass 1: fetch Jira for tickets missing sprint/epic/status ────────────────
  // Catches tickets created before these fields were persisted, or tickets
  // whose status was never set (no status-change webhook received yet).
  const missing = ticketStore.getAllTickets().filter(
    t => !t.sprint || !t.epic || !t.jiraStatus,
  );

  if (missing.length) {
    logger.info(`Backfilling metadata for ${missing.length} ticket(s)…`);
    let updated = 0;
    for (const ticket of missing) {
      try {
        const issue  = await jiraClient.getIssue(ticket.key);
        // Always store the current Jira status (fills blank badges)
        if (!ticket.jiraStatus) {
          ticketStore.updateTicketStatus(ticket.key, issue.fields.status.name);
        }
        const sprint = extractSprintName(issue.fields);
        const epic   = extractEpicRef(issue.fields);
        if (sprint || epic) {
          ticketStore.updateTicketMeta(ticket.key, {
            sprint,
            sprintIsActive: isSprintActive(issue.fields),
            epic,
          });
        }
        updated++;
      } catch {
        // Non-fatal — skip tickets we can't fetch (e.g. deleted or access denied)
      }
      await new Promise<void>(r => setTimeout(r, 300));
    }
    if (updated) logger.info(`Metadata backfill complete — updated ${updated} ticket(s)`);
  }

  // ── Pass 2: fill blank titles from Jira summary ──────────────────────────────
  const noTitle = ticketStore.getAllTickets().filter(t => !t.title);

  if (noTitle.length) {
    logger.info(`Backfilling titles for ${noTitle.length} ticket(s)…`);
    let titleUpdated = 0;
    for (const ticket of noTitle) {
      try {
        const issue = await jiraClient.getIssue(ticket.key);
        ticketStore.updateTicketTitle(ticket.key, issue.fields.summary);
        titleUpdated++;
      } catch { /* non-fatal */ }
      await new Promise<void>(r => setTimeout(r, 300));
    }
    if (titleUpdated) logger.info(`Title backfill complete — updated ${titleUpdated} ticket(s)`);
  }

  // ── Pass 3: fetch Jira status for epics that don't have it yet ───────────────
  const needEpicStatus = ticketStore.getAllTickets().filter(t => t.epic && !t.epicStatus);

  if (needEpicStatus.length) {
    // Collect unique epic keys to minimise Jira API calls
    const epicKeys = [...new Set(needEpicStatus.map(t => t.epic!))];
    logger.info(`Backfilling epic status for ${epicKeys.length} unique epic(s)…`);

    const epicStatusMap = new Map<string, string>();
    for (const epicKey of epicKeys) {
      try {
        const epicIssue = await jiraClient.getIssue(epicKey);
        epicStatusMap.set(epicKey, epicIssue.fields.status.name);
      } catch {
        // Epic may not be accessible — skip silently
      }
      await new Promise<void>(r => setTimeout(r, 300));
    }

    // Write epicStatus onto every child ticket
    let epicUpdated = 0;
    for (const ticket of needEpicStatus) {
      const status = ticket.epic ? epicStatusMap.get(ticket.epic) : undefined;
      if (status) {
        ticketStore.updateTicketMeta(ticket.key, { epicStatus: status });
        epicUpdated++;
      }
    }
    if (epicUpdated) logger.info(`Epic status backfill complete — updated ${epicUpdated} ticket(s)`);
  }
}
