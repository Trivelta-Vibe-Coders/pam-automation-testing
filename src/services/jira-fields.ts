/**
 * Helpers for extracting sprint / epic metadata from Jira issue fields.
 * Shared by ticket-created, ticket-updated, and the startup backfill.
 */
import { JiraIssueFields } from '../types';

/** Extract the active (or most-recent) sprint name from customfield_10020. */
export function extractSprintName(fields: JiraIssueFields): string | undefined {
  const raw = fields['customfield_10020'];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const active = (raw as any[]).find((s: any) => s?.state === 'active') ?? raw[raw.length - 1];
  return active?.name ? String(active.name) : undefined;
}

/**
 * True when the issue has a sprint whose state is explicitly "active".
 * Used to identify the current sprint without guessing.
 */
export function isSprintActive(fields: JiraIssueFields): boolean {
  const raw = fields['customfield_10020'];
  if (!Array.isArray(raw)) return false;
  return (raw as any[]).some((s: any) => s?.state === 'active');
}

/**
 * Extract an epic reference as a Jira key (e.g. "PAMENG-42") whenever possible
 * so the UI can look up the epic ticket's own status in the ticket store.
 *
 * Priority:
 *  1. customfield_10014 — classic project epic link (already a key)
 *  2. parent field (next-gen/team-managed) — prefer key over summary
 */
export function extractEpicRef(fields: JiraIssueFields): string | undefined {
  const cl = fields['customfield_10014'];
  if (typeof cl === 'string' && cl) return cl;
  const parent = fields['parent'] as any;
  if (parent?.fields?.issuetype?.name === 'Epic') {
    // Prefer key so the frontend can look it up in the ticket store
    return String(parent.key ?? parent.fields?.summary ?? '');
  }
  return undefined;
}
