/**
 * Per-flow last-run tracker.
 *
 * Records the most recent test result (pass/fail + timestamp + runUrl) for
 * each (suiteName, flowName, environment) triple.
 *
 * Updated in real time by the batch poller after every completed run.
 * Back-filled on startup from historical ticket events so the Test Runner
 * tab shows data immediately after deploy without waiting for a new run.
 *
 * Backed by DATA_DIR/flow-last-runs.json on the Railway volume.
 */
import fs   from 'fs';
import path from 'path';
import { config } from '../config';

const STORE_PATH = path.join(config.dataDir, 'flow-last-runs.json');

export interface FlowRunRecord {
  suiteName:   string;
  flowName:    string;
  environment: string;
  timestamp:   string;   // ISO — used to keep only the most recent result
  passed:      boolean;
  runUrl?:     string;   // link to the Autosana suite-run page
}

const store = new Map<string, FlowRunRecord>(); // key: `${suiteName}||${flowName}||${env}`

function storeKey(suiteName: string, flowName: string, env: string): string {
  return `${suiteName}||${flowName}||${env}`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: FlowRunRecord[] = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const r of raw) store.set(storeKey(r.suiteName, r.flowName, r.environment), r);
    console.log(`[flow-last-run] Loaded ${store.size} record(s) from ${STORE_PATH}`);
  } catch (err) {
    console.warn('[flow-last-run] Could not load:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify([...store.values()], null, 2));
  } catch (err) {
    console.warn('[flow-last-run] Could not save:', err);
  }
}

loadFromDisk();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record the outcome of every flow in a completed batch.
 * Only updates a record if the new timestamp is more recent than what's stored.
 * Called by the batch poller after a run completes.
 */
export function updateFlowRuns(
  groups: Array<{
    suiteName:      string;
    runUrl?:        string;
    allFlowDetails: Array<{ name: string; status: string }>;
  }>,
  environment: string,
  timestamp:   string,
): void {
  let changed = false;
  for (const g of groups) {
    for (const f of g.allFlowDetails) {
      const k        = storeKey(g.suiteName, f.name, environment);
      const existing = store.get(k);
      if (existing && existing.timestamp >= timestamp) continue; // already up to date
      store.set(k, {
        suiteName:   g.suiteName,
        flowName:    f.name,
        environment,
        timestamp,
        passed:      f.status === 'passed',
        runUrl:      g.runUrl,
      });
      changed = true;
    }
  }
  if (changed) saveToDisk();
}

/**
 * One-time back-fill from historical ticket events.
 * Scans all stored ticket events that contain testResults and records the
 * most recent result for each (suiteName, flowName, environment) triple.
 * Only persists if new data was found.
 */
export function backfillFromTicketEvents(
  getAllTickets: () => Array<{
    events: Array<{
      timestamp: string;
      details?:  Record<string, unknown>;
    }>;
  }>,
): void {
  let count   = 0;
  let changed = false;

  for (const ticket of getAllTickets()) {
    for (const ev of ticket.events) {
      const testResults = ev.details?.['testResults'] as Array<{
        suiteName:      string;
        runUrl?:        string;
        allFlowDetails?: Array<{ name: string; status: string }>;
      }> | undefined;

      const environment = String(ev.details?.['environment'] ?? '');
      if (!Array.isArray(testResults) || !environment) continue;

      for (const r of testResults) {
        for (const f of (r.allFlowDetails ?? [])) {
          const k        = storeKey(r.suiteName, f.name, environment);
          const existing = store.get(k);
          if (existing && existing.timestamp >= ev.timestamp) continue;
          store.set(k, {
            suiteName:   r.suiteName,
            flowName:    f.name,
            environment,
            timestamp:   ev.timestamp,
            passed:      f.status === 'passed',
            runUrl:      r.runUrl,
          });
          count++;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    saveToDisk();
    console.log(`[flow-last-run] Back-filled ${count} record(s) from ticket events`);
  } else {
    console.log(`[flow-last-run] Back-fill: no new data found`);
  }
}

export function getAllRuns(): FlowRunRecord[] {
  return [...store.values()];
}
