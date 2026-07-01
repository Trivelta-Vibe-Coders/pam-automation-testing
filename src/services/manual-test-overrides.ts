/**
 * Persistent store: manual test override flags on the dashboard.
 *
 * `confirmed`  — team confirmed manual testing is done → routes to Passing.
 * `failing`    — team flagged manual testing as failing → routes to Blockers.
 * `notNeeded`  — team decided no testing is needed at all → hidden from view
 *                (shown in a collapsed "Not needed" section with an undo button).
 *
 * All flags are scoped to a card ('stg' | 'prod').
 * Each setter clears the other two flags — only one state can be active at once.
 * Backed by DATA_DIR/manual-test-overrides.json.
 */
import fs   from 'fs';
import path from 'path';
import { config } from '../config';

const STORE_PATH = path.join(config.dataDir, 'manual-test-overrides.json');

const confirmed = new Set<string>();
const failing   = new Set<string>();
const notNeeded = new Set<string>();

function storeKey(ticketKey: string, card: 'stg' | 'prod'): string {
  return `${ticketKey}:${card}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: { confirmed?: string[]; failing?: string[]; notNeeded?: string[] } =
      JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const k of (raw.confirmed ?? [])) confirmed.add(k);
    for (const k of (raw.failing   ?? [])) failing.add(k);
    for (const k of (raw.notNeeded ?? [])) notNeeded.add(k);
    console.log(`[manual-test-overrides] Loaded ${confirmed.size} confirmed, ${failing.size} failing, ${notNeeded.size} not-needed`);
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
      notNeeded: [...notNeeded],
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

export function isNotNeeded(ticketKey: string, card: 'stg' | 'prod'): boolean {
  return notNeeded.has(storeKey(ticketKey, card));
}

export function setConfirmed(ticketKey: string, card: 'stg' | 'prod', value: boolean): void {
  const k = storeKey(ticketKey, card);
  if (value) { confirmed.add(k); failing.delete(k); notNeeded.delete(k); }
  else        { confirmed.delete(k); }
  saveToDisk();
}

export function setFailing(ticketKey: string, card: 'stg' | 'prod', value: boolean): void {
  const k = storeKey(ticketKey, card);
  if (value) { failing.add(k); confirmed.delete(k); notNeeded.delete(k); }
  else        { failing.delete(k); }
  saveToDisk();
}

export function setNotNeeded(ticketKey: string, card: 'stg' | 'prod', value: boolean): void {
  const k = storeKey(ticketKey, card);
  if (value) { notNeeded.add(k); confirmed.delete(k); failing.delete(k); }
  else        { notNeeded.delete(k); }
  saveToDisk();
}
