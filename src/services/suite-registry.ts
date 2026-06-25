/**
 * Dynamic suite registry.
 *
 * Fetches all suites from the Autosana workspace at startup and caches them.
 * Any suite added to the workspace is automatically picked up on next restart.
 * No hardcoded suite IDs needed.
 */
import { listSuites } from './autosana';

let nameToId = new Map<string, string>();
let idToName = new Map<string, string>();

export async function refresh(): Promise<void> {
  const suites = await listSuites();
  nameToId = new Map(suites.map(s => [s.name, s.id]));
  idToName = new Map(suites.map(s => [s.id, s.name]));
}

export function getSuiteId(name: string): string | undefined {
  return nameToId.get(name);
}

export function getSuiteName(id: string): string | undefined {
  return idToName.get(id);
}

export function getAllSuiteIds(): string[] {
  return [...nameToId.values()];
}

export function getAllSuites(): Array<{ name: string; id: string }> {
  return [...nameToId.entries()].map(([name, id]) => ({ name, id }));
}
