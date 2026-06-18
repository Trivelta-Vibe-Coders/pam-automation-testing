/**
 * Persistent per-ticket event store.
 *
 * Stores the full history for each PAMENG ticket independently of the
 * activity-log ring buffer, so ticket cards survive both redeploys and
 * the 500-event limit.
 *
 * Backed by DATA_DIR/tickets.json on the Railway volume.
 */
import fs   from 'fs';
import path from 'path';
import { ActivityEvent, ActivityLevel } from '../types';

const DATA_DIR   = process.env['DATA_DIR'] ?? '/app/data';
const STORE_PATH = path.join(DATA_DIR, 'tickets.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TicketRecord {
  key:          string;
  title:        string;        // extracted from "Ticket created: …" message
  level:        ActivityLevel; // highest severity seen on this ticket
  jiraStatus:   string;        // most-recent Jira status (e.g. "Dev", "Done")
  sprint?:        string;        // active sprint name, e.g. "Sprint 5"
  sprintIsActive?: boolean;     // true when the sprint was explicitly state=active in Jira
  epic?:          string;       // epic key, e.g. "PAMENG-12"
  epicStatus?:    string;       // Jira status of the epic ticket, e.g. "In Progress"
  noTestNeeded?: boolean;      // manually marked — skip AI gate and test triggers
  events:       ActivityEvent[];
  createdAt:    string;
  updatedAt:    string;
}

// ── In-memory map ─────────────────────────────────────────────────────────────

const store = new Map<string, TicketRecord>();

function levelPriority(l: ActivityLevel): number {
  return ({ error: 3, warning: 2, success: 1, info: 0 } as Record<string, number>)[l] ?? 0;
}

// ── Event deduplication ───────────────────────────────────────────────────────

/**
 * Remove duplicate events from a ticket's history.
 *
 * Dedup key strategy:
 *  - If the event has a batchId in details → key = message + batchId
 *    (same message from a different batch is a real separate event)
 *  - Otherwise → key = message + minute-bucket (YYYY-MM-DDTHH:MM)
 *    (same message within the same minute is almost certainly a webhook retry)
 */
function deduplicateEvents(events: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<string>();
  const result: ActivityEvent[] = [];
  for (const e of events) {
    const batchId = String((e.details as Record<string, unknown>)?.batchId ?? '');
    const minute  = e.timestamp.slice(0, 16);  // "2024-01-15T10:30"
    const dedupKey = batchId
      ? `${e.message}||batch:${batchId}`
      : `${e.message}||min:${minute}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      result.push(e);
    }
  }
  return result;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: TicketRecord[] = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    let dedupCount = 0;
    for (const rec of raw) {
      const before = rec.events.length;
      rec.events = deduplicateEvents(rec.events);
      dedupCount += before - rec.events.length;
      store.set(rec.key, rec);
    }
    const dedupNote = dedupCount > 0 ? ` — removed ${dedupCount} duplicate event(s)` : '';
    console.log(`[ticket-store] Loaded ${store.size} ticket(s) from ${STORE_PATH}${dedupNote}`);
    if (dedupCount > 0) saveToDisk(); // write the deduplicated data back immediately
  } catch (err) {
    console.warn('[ticket-store] Could not load:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...store.values()], null, 2));
  } catch (err) {
    console.warn('[ticket-store] Could not save:', err);
  }
}

loadFromDisk();

// ── Helpers ───────────────────────────────────────────────────────────────────

const TITLE_RE = /^Ticket created:\s*\S+\s*—\s*"(.+)"$/;
const PAM_RE   = /^PAMENG-\d+$/;

/**
 * Extract a PAMENG-XXXX key from a log event.
 * Mirrors the client-side extractTicketKey logic.
 */
export function extractPamKey(
  message: string,
  details?: Record<string, unknown>,
): string | null {
  const d = details ?? {};
  if (d['key']         && PAM_RE.test(String(d['key'])))         return String(d['key']);
  if (d['jiraKey']     && PAM_RE.test(String(d['jiraKey'])))     return String(d['jiraKey']);
  if (d['triggeredBy'] && PAM_RE.test(String(d['triggeredBy']))) return String(d['triggeredBy']);
  const m = message.match(/\bPAMENG-\d+\b/);
  return m ? m[0] : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a log event against its PAMENG ticket.
 * Called automatically by logger.ts for every event that contains a key.
 */
export function addEvent(key: string, event: ActivityEvent): void {
  const now = event.timestamp;

  if (!store.has(key)) {
    store.set(key, { key, title: '', level: 'info', jiraStatus: '', events: [], createdAt: now, updatedAt: now });
  }

  const rec = store.get(key)!;

  // ── Dedup guard ──────────────────────────────────────────────────────────────
  // Skip if an identical event was already recorded within the last 2 minutes.
  // Uses the same key strategy as deduplicateEvents().
  const batchId  = String(event.details?.batchId ?? '');
  const minute   = event.timestamp.slice(0, 16);
  const dedupKey = batchId
    ? `${event.message}||batch:${batchId}`
    : `${event.message}||min:${minute}`;
  const alreadySeen = rec.events.some(e => {
    const eb = String(e.details?.batchId ?? '');
    const em = e.timestamp.slice(0, 16);
    const ek = eb ? `${e.message}||batch:${eb}` : `${e.message}||min:${em}`;
    return ek === dedupKey;
  });
  if (alreadySeen) return;

  // Extract ticket title from the creation message
  if (!rec.title) {
    const m = event.message.match(TITLE_RE);
    if (m) rec.title = m[1];
  }

  // Escalate severity
  if (levelPriority(event.level) > levelPriority(rec.level)) {
    rec.level = event.level;
  }

  rec.events.push(event);
  rec.updatedAt = now;

  saveToDisk();
}

/**
 * Update the current Jira status for a ticket.
 * Called whenever a status change webhook is received.
 */
export function updateTicketStatus(key: string, status: string): void {
  if (!store.has(key)) {
    const now = new Date().toISOString();
    store.set(key, { key, title: '', level: 'info', jiraStatus: status, events: [], createdAt: now, updatedAt: now });
  } else {
    const rec = store.get(key)!;
    rec.jiraStatus = status;
    rec.updatedAt  = new Date().toISOString();
  }
  saveToDisk();
}

/**
 * Manually mark (or unmark) a ticket as not needing test coverage.
 * When set, test triggers are skipped for this ticket.
 */
export function setNoTestNeeded(key: string, value: boolean): void {
  if (!store.has(key)) {
    const now = new Date().toISOString();
    store.set(key, { key, title: '', level: 'info', jiraStatus: '', events: [], createdAt: now, updatedAt: now });
  }
  const rec = store.get(key)!;
  rec.noTestNeeded = value || undefined; // store undefined instead of false to keep JSON clean
  rec.updatedAt    = new Date().toISOString();
  saveToDisk();
}

/**
 * Set the display title for a ticket (backfill from Jira summary).
 * Only writes if the title is currently blank.
 */
export function updateTicketTitle(key: string, title: string): void {
  if (!store.has(key)) return; // only update existing records
  const rec = store.get(key)!;
  if (rec.title) return;       // already set — don't overwrite
  rec.title     = title;
  rec.updatedAt = new Date().toISOString();
  saveToDisk();
}

/**
 * Update sprint / epic metadata for a ticket.
 * Called when a webhook payload includes those custom fields.
 */
export function updateTicketMeta(
  key: string,
  meta: { sprint?: string; sprintIsActive?: boolean; epic?: string; epicStatus?: string },
): void {
  if (!store.has(key)) {
    const now = new Date().toISOString();
    store.set(key, { key, title: '', level: 'info', jiraStatus: '', events: [], createdAt: now, updatedAt: now });
  }
  const rec = store.get(key)!;
  if (meta.sprint         !== undefined) rec.sprint         = meta.sprint         || undefined;
  if (meta.sprintIsActive !== undefined) rec.sprintIsActive = meta.sprintIsActive || undefined;
  if (meta.epic           !== undefined) rec.epic           = meta.epic           || undefined;
  if (meta.epicStatus     !== undefined) rec.epicStatus     = meta.epicStatus     || undefined;
  saveToDisk();
}

/** Return all tickets, newest-updated first. */
export function getAllTickets(): TicketRecord[] {
  return [...store.values()].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function getTicket(key: string): TicketRecord | undefined {
  return store.get(key);
}
