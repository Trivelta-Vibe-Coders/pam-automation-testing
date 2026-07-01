/**
 * Persistent store: manual test override flags on the dashboard.
 *
 * `confirmed` — team has confirmed manual testing is done for this ticket.
 *               Routes the ticket to the "Passing" section.
 * `failing`   — team has flagged manual testing as failing.
 *               Routes the ticket to the "Blockers" section.
 *
 * Both flags are scoped to a card ('stg' | 'prod').
 * Backed by DATA_DIR/manual-test-overrides.json.
 */
import fs   from 'fs';
import path from 'path';
import { config } from '../config';

const STORE_PATH = path.join(config.dataDir, 'manual-test-overrides.json');

const confirmed = new Set<string>();
const failing   = new Set<string>();

function storeKey(ticketKey: string, card: 'stg' | 'prod'): string {
  return `${ticketKey}:${card}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: { confirmed: string[]; failing: string[] } =
      JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const k of (raw.confirmed ?? [])) confirmed.add(k);
    for (const k of (raw.failing   ?? [])) failing.add(k);
    console.log(`[manual-test-overrides] Loaded ${confirmed.size} confirmed, ${failing.size} failing`);
  } catch (err) {
    console.warn('[manual-test-overrides] Could not load:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify({
      confirmed: [...confirmed],
      failing:   [...failing],
    }, null, 2));
  } catch (err) {
    console.warn('[manual-test-overrides] Could not save:', err);
  }
}

loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

export function isConfirmed(ticketKey: string, card: 'stg' | 'prod'): boolean {
  return confirmed.has(storeKey(ticketKey, card));
}

export function isFailing(ticketKey: string, card: 'stg' | 'prod'): boolean {
  return failing.has(storeKey(ticketKey, card));
}

export function setConfirmed(ticketKey: string, card: 'stg' | 'prod', value: boolean): void {
  const k = storeKey(ticketKey, card);
  if (value) { confirmed.add(k); failing.delete(k); }
  else        { confirmed.delete(k); }
  saveToDisk();
}

export function setFailing(ticketKey: string, card: 'stg' | 'prod', value: boolean): void {
  const k = storeKey(ticketKey, card);
  if (value) { failing.add(k); confirmed.delete(k); }
  else        { failing.delete(k); }
  saveToDisk();
}
