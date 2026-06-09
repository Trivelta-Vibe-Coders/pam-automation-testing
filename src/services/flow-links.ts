/**
 * Persistent store: Jira issue key → one or more Autosana flows.
 *
 * Backed by an in-memory Map, synced to DATA_DIR/flow-links.json.
 *
 * Migration: handles the old single-flow format (top-level flowId/flowName/suiteId)
 * and converts it to the new multi-flow format ({ flows: FlowEntry[] }) on load.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { FlowLink, FlowEntry } from '../types';

const STORE_PATH = path.join(config.dataDir, 'flow-links.json');

const store = new Map<string, FlowLink>();

// ── Migration ─────────────────────────────────────────────────────────────────

/** Convert old single-flow records to the new multi-flow shape. */
function migrate(raw: any[]): FlowLink[] {
  return raw.map(item => {
    if (Array.isArray(item.flows)) return item as FlowLink;
    // Old format: top-level flowId/flowName/suiteId
    return {
      jiraKey:   item.jiraKey,
      flows:     [{ flowId: item.flowId, flowName: item.flowName, suiteId: item.suiteId }],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    } as FlowLink;
  });
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const link of migrate(raw)) store.set(link.jiraKey, link);
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

loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a flow to a ticket's link list.
 * Creates the record if it doesn't exist; ignores duplicates (same flowId).
 */
export function addFlow(jiraKey: string, entry: FlowEntry): FlowLink {
  const now = new Date().toISOString();
  if (!store.has(jiraKey)) {
    store.set(jiraKey, { jiraKey, flows: [], createdAt: now, updatedAt: now });
  }
  const link = store.get(jiraKey)!;
  if (!link.flows.find(f => f.flowId === entry.flowId)) {
    link.flows.push(entry);
    link.updatedAt = now;
    saveToDisk();
  }
  return link;
}

/**
 * Remove a single flow from a ticket's link list.
 * Deletes the whole record if it was the last flow.
 * Returns true if anything was removed.
 */
export function removeFlow(jiraKey: string, flowId: string): boolean {
  const link = store.get(jiraKey);
  if (!link) return false;
  const before = link.flows.length;
  link.flows = link.flows.filter(f => f.flowId !== flowId);
  if (link.flows.length === 0) {
    store.delete(jiraKey);
  } else {
    link.updatedAt = new Date().toISOString();
  }
  if (link.flows.length !== before) { saveToDisk(); return true; }
  return false;
}

/** Remove all flows for a ticket. */
export function deleteLink(jiraKey: string): boolean {
  const deleted = store.delete(jiraKey);
  if (deleted) saveToDisk();
  return deleted;
}

export function getLink(jiraKey: string): FlowLink | undefined {
  return store.get(jiraKey);
}

export function getAllLinks(): FlowLink[] {
  return [...store.values()];
}
