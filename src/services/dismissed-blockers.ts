/**
 * Persistent store: tickets manually dismissed as "not a blocker" on the dashboard.
 *
 * A dismissal is scoped to a card ('stg' | 'prod') so a test failure can be
 * dismissed for the staging-readiness check without affecting the prod check.
 *
 * Backed by DATA_DIR/dismissed-blockers.json.
 */
import fs   from 'fs';
import path from 'path';
import { config } from '../config';

const STORE_PATH = path.join(config.dataDir, 'dismissed-blockers.json');

// Set of "PAMENG-123:stg" / "PAMENG-123:prod" strings
const store = new Set<string>();

function storeKey(ticketKey: string, card: 'stg' | 'prod'): string {
  return `${ticketKey}:${card}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: string[] = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const k of raw) store.add(k);
    console.log(`[dismissed-blockers] Loaded ${store.size} dismissal(s)`);
  } catch (err) {
    console.warn('[dismissed-blockers] Could not load:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...store], null, 2));
  } catch (err) {
    console.warn('[dismissed-blockers] Could not save:', err);
  }
}

loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

export function isDismissed(ticketKey: string, card: 'stg' | 'prod'): boolean {
  return store.has(storeKey(ticketKey, card));
}

export function setDismissed(ticketKey: string, card: 'stg' | 'prod', dismissed: boolean): void {
  if (dismissed) store.add(storeKey(ticketKey, card));
  else           store.delete(storeKey(ticketKey, card));
  saveToDisk();
}
