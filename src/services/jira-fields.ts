/**
 * Helpers for extracting sprint / epic metadata from Jira issue fields.
 * Shared by ticket-created, ticket-updated, and the startup backfill.
 */
import { JiraIssueFields } from '../types';

/** Extract the active sprint name from customfield_10020 (Jira Cloud). */
export function extractSprintName(fields: JiraIssueFields): string | undefined {
  const raw = fields['customfield_10020'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const active = (raw as any[]).find((s: any) => s?.state === 'active') ?? raw[raw.length - 1];
  return active?.name ? String(active.name) : undefined;
}

/**
 * Extract an epic reference.
 * Tries customfield_10014 (classic project epic link key) first,
 * then falls back to the parent field for team-managed / next-gen projects.
 */
export function extractEpicRef(fields: JiraIssueFields): string | undefined {
  const cl = fields['customfield_10014'];
  if (typeof cl === 'string' && cl) return cl;
  const parent = fields['parent'] as any;
  if (parent?.fields?.issuetype?.name === 'Epic') {
    return String(parent.fields?.summary ?? parent.key ?? '');
  }
  return undefined;
}
