/**
 * Startup backfill: fetch sprint/epic from Jira for any stored ticket that
 * is missing that metadata (i.e. tickets processed before this feature existed).
 *
 * Runs once in the background after the server starts — failures are logged
 * but never fatal.  A 300 ms delay between requests avoids hammering Jira.
 */
import * as ticketStore from './ticket-store';
import * as jiraClient  from './jira';
import { extractSprintName, extractEpicRef } from './jira-fields';
import * as logger from '../logger';

export async function backfillTicketMeta(): Promise<void> {
  const missing = ticketStore.getAllTickets().filter(t => !t.sprint && !t.epic);
  if (!missing.length) return;

  logger.info(`Backfilling sprint/epic metadata for ${missing.length} ticket(s)…`);

  let updated = 0;
  for (const ticket of missing) {
    try {
      const issue  = await jiraClient.getIssue(ticket.key);
      const sprint = extractSprintName(issue.fields);
      const epic   = extractEpicRef(issue.fields);
      if (sprint || epic) {
        ticketStore.updateTicketMeta(ticket.key, { sprint, epic });
        updated++;
      }
    } catch {
      // Non-fatal — skip tickets we can't fetch (e.g. deleted or access denied)
    }
    // Small pause so we don't exceed Jira rate limits
    await new Promise<void>(r => setTimeout(r, 300));
  }

  if (updated) logger.info(`Sprint/epic backfill complete — updated ${updated} ticket(s)`);
}
