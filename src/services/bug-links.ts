/**
 * Persistent bug-link store.
 *
 * Maps a bug ticket key → the parent ticket it was filed against.
 * When a bug ticket changes status to a trigger environment (Dev → dev,
 * Stg → staging), the parent ticket's linked flows are automatically re-run.
 *
 * Backed by DATA_DIR/bug-links.json on the Railway volume.
 * Manual removal only — links persist until explicitly deleted.
 */
import fs   from 'fs';
import path from 'path';
import { config } from '../config';

const STORE_PATH = path.join(config.dataDir, 'bug-links.json');

export interface BugLink {
  bugKey:    string;  // e.g. "PAMENG-205" — the bug/fix ticket
  parentKey: string;  // e.g. "PAMENG-100" — the ticket whose tests should re-run
  linkedAt:  string;  // ISO timestamp
}

const store = new Map<string, BugLink>(); // keyed by bugKey

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: BugLink[] = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const link of raw) store.set(link.bugKey, link);
    console.log(`[bug-links] Loaded ${store.size} bug link(s) from ${STORE_PATH}`);
  } catch (err) {
    console.warn('[bug-links] Could not load:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...store.values()], null, 2));
  } catch (err) {
    console.warn('[bug-links] Could not save:', err);
  }
}

loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

export function addBugLink(bugKey: string, parentKey: string): BugLink {
  const link: BugLink = { bugKey, parentKey, linkedAt: new Date().toISOString() };
  store.set(bugKey, link);
  saveToDisk();
  return link;
}

/** Returns true if a link existed and was removed. */
export function removeBugLink(bugKey: string): boolean {
  const existed = store.delete(bugKey);
  if (existed) saveToDisk();
  return existed;
}

/** Look up by bug ticket key — used in the webhook handler. */
export function getBugLink(bugKey: string): BugLink | undefined {
  return store.get(bugKey);
}

/** All bug tickets linked to a given parent ticket — used by the dashboard. */
export function getBugLinksForParent(parentKey: string): BugLink[] {
  return [...store.values()].filter(l => l.parentKey === parentKey);
}

export function getAllBugLinks(): BugLink[] {
  return [...store.values()];
}
