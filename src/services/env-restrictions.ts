/**
 * Persistent store: flow IDs excluded from specific environments.
 *
 * Stored as DATA_DIR/env-restrictions.json:
 *   { "dev": ["flow-id-1", "flow-id-2"], ... }
 *
 * Use case: mark flows that don't work in dev so they're skipped when
 * test runs are triggered against the dev environment.
 */
import fs   from 'fs';
import path from 'path';
import { config } from '../config';

const STORE_PATH = path.join(config.dataDir, 'env-restrictions.json');

// environment → Set of excluded flow IDs
const store = new Map<string, Set<string>>();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: Record<string, string[]> = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const [env, flowIds] of Object.entries(raw)) {
      store.set(env, new Set(flowIds));
    }
    console.log(`[env-restrictions] Loaded restrictions from ${STORE_PATH}`);
  } catch (err) {
    console.warn('[env-restrictions] Could not load:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const obj: Record<string, string[]> = {};
    for (const [env, flowIds] of store) {
      if (flowIds.size > 0) obj[env] = [...flowIds];
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn('[env-restrictions] Could not save:', err);
  }
}

loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true if this flow should be skipped for the given environment. */
export function isExcluded(flowId: string, environment: string): boolean {
  return store.get(environment)?.has(flowId) ?? false;
}

/** All flow IDs excluded from a given environment. */
export function getExcludedForEnv(environment: string): string[] {
  return [...(store.get(environment) ?? [])];
}

/** Full map for serialisation (e.g. GET /api/env-restrictions). */
export function getAll(): Record<string, string[]> {
  const obj: Record<string, string[]> = {};
  for (const [env, flowIds] of store) {
    obj[env] = [...flowIds];
  }
  return obj;
}

/** Add or remove a flow exclusion. */
export function setExclusion(flowId: string, environment: string, excluded: boolean): void {
  if (!store.has(environment)) store.set(environment, new Set());
  const set = store.get(environment)!;
  if (excluded) set.add(flowId);
  else          set.delete(flowId);
  saveToDisk();
}
