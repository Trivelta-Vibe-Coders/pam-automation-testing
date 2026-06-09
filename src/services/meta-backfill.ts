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

export async function backfillTicketMeta(): Promise<void> {
  // ── Pass 1: fill sprint/epic for tickets missing that data ──────────────────
  const missing = ticketStore.getAllTickets().filter(t => !t.sprint && !t.epic);

  if (missing.length) {
    logger.info(`Backfilling sprint/epic metadata for ${missing.length} ticket(s)…`);
    let updated = 0;
    for (const ticket of missing) {
      try {
        const issue  = await jiraClient.getIssue(ticket.key);
        const sprint = extractSprintName(issue.fields);
        const epic   = extractEpicRef(issue.fields);
        if (sprint || epic) {
          ticketStore.updateTicketMeta(ticket.key, {
            sprint,
            sprintIsActive: isSprintActive(issue.fields),
            epic,
          });
          updated++;
        }
      } catch {
        // Non-fatal — skip tickets we can't fetch (e.g. deleted or access denied)
      }
      await new Promise<void>(r => setTimeout(r, 300));
    }
    if (updated) logger.info(`Sprint/epic backfill complete — updated ${updated} ticket(s)`);
  }

  // ── Pass 2: fetch Jira status for epics that don't have it yet ───────────────
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
