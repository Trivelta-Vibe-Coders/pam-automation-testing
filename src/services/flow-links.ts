/**
 * Persistent store: Jira issue key → Autosana flow ID.
 *
 * Backed by an in-memory Map, synced to DATA_DIR/flow-links.json.
 * If the file doesn't exist (fresh deploy), the map starts empty.
 * On restart, existing links are restored from the JSON file.
 *
 * Railway note: mount a Railway Volume at /app/data to survive redeploys.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { FlowLink } from '../types';

const STORE_PATH = path.join(config.dataDir, 'flow-links.json');

// in-memory map: jiraKey → FlowLink
const store = new Map<string, FlowLink>();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: FlowLink[] = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const link of raw) {
      store.set(link.jiraKey, link);
    }
    console.log(`[flow-links] Loaded ${store.size} link(s) from ${STORE_PATH}`);
  } catch (err) {
    console.warn(`[flow-links] Could not load ${STORE_PATH}:`, err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...store.values()], null, 2));
  } catch (err) {
    console.warn(`[flow-links] Could not save ${STORE_PATH}:`, err);
  }
}

// Load on module init
loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

export function setLink(link: FlowLink): void {
  store.set(link.jiraKey, link);
  saveToDisk();
}

export function getLink(jiraKey: string): FlowLink | undefined {
  return store.get(jiraKey);
}

export function getAllLinks(): FlowLink[] {
  return [...store.values()];
}

export function deleteLink(jiraKey: string): boolean {
  const deleted = store.delete(jiraKey);
  if (deleted) saveToDisk();
  return deleted;
}
