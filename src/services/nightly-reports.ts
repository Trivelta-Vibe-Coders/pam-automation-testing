/**
 * Nightly test run report store.
 *
 * Records the full results of every completed nightly regression run.
 * Back-filled on startup from existing activity log events so data
 * is available immediately after deploy.
 * Updated in real time by the batch poller when triggeredBy === 'nightly'.
 *
 * Backed by DATA_DIR/nightly-reports.json on the Railway volume.
 * Capped at 90 reports (~3 months of daily runs).
 */
import fs   from 'fs';
import path from 'path';
import { config } from '../config';
import { ActivityEvent } from '../types';

const STORE_PATH  = path.join(config.dataDir, 'nightly-reports.json');
const MAX_REPORTS = 90;

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface FlowResult {
  name:    string;
  status:  string;   // 'passed' | 'failed' | 'error' | …
  summary: string;   // AI failure reason; empty when passed
}

export interface SuiteResult {
  suiteName: string;
  runUrl?:   string;
  passed:    number;
  failed:    number;
  flows:     FlowResult[];
}

export interface NightlyReport {
  id:          string;    // unique — matches the source activity-log event ID
  timestamp:   string;    // ISO
  environment: string;    // 'staging' | 'dev'
  batchId:     string;
  testSummary: string;    // AI-generated summary; empty when not available
  totalPassed: number;
  totalFailed: number;
  suites:      SuiteResult[];
}

// ── In-memory store ───────────────────────────────────────────────────────────

const reports: NightlyReport[] = []; // sorted newest → oldest
const seenIds = new Set<string>();

// ── Persistence ───────────────────────────────────────────────────────────────

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw: NightlyReport[] = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    for (const r of raw) { reports.push(r); seenIds.add(r.id); }
    console.log(`[nightly-reports] Loaded ${reports.length} report(s) from ${STORE_PATH}`);
  } catch (err) {
    console.warn('[nightly-reports] Could not load:', err);
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(reports, null, 2));
  } catch (err) {
    console.warn('[nightly-reports] Could not save:', err);
  }
}

loadFromDisk();

// ── Helpers ───────────────────────────────────────────────────────────────────

type RawTestResult = {
  suiteName:        string;
  runUrl?:          string;
  passed:           number;
  failed:           number;
  allFlowDetails?:  Array<{ name: string; status: string; summary?: string }>;
  failedFlowDetails?: Array<{ name: string; summary?: string }>;
};

function buildFromEvent(ev: ActivityEvent): NightlyReport | null {
  const d = ev.details ?? {};
  const raw = d['testResults'] as RawTestResult[] | undefined;
  if (!Array.isArray(raw) || !raw.length) return null;

  const suites: SuiteResult[] = raw.map(r => ({
    suiteName: r.suiteName,
    runUrl:    r.runUrl,
    passed:    r.passed,
    failed:    r.failed,
    flows:     (r.allFlowDetails ?? []).map(f => ({
      name:    f.name,
      status:  f.status,
      summary: f.summary ?? '',
    })),
  }));

  return {
    id:          ev.id,
    timestamp:   ev.timestamp,
    environment: String(d['environment'] ?? 'staging'),
    batchId:     String(d['batchId']     ?? ''),
    testSummary: String(d['testSummary'] ?? ''),
    totalPassed: suites.reduce((s, r) => s + r.passed, 0),
    totalFailed: suites.reduce((s, r) => s + r.failed, 0),
    suites,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store a completed nightly run result.
 * Called by the batch poller (via the return value of logFn) immediately
 * after the result event is emitted. Idempotent — duplicate IDs are ignored.
 */
export function addReport(ev: ActivityEvent): void {
  if (seenIds.has(ev.id)) return;
  const report = buildFromEvent(ev);
  if (!report) return;

  reports.unshift(report); // prepend — newest first
  seenIds.add(ev.id);
  if (reports.length > MAX_REPORTS) reports.splice(MAX_REPORTS);
  saveToDisk();
}

/**
 * One-time back-fill from the activity log.
 * Finds all events with triggeredBy === 'nightly' + testResults data that
 * haven't been persisted yet, sorts them, and writes to disk.
 */
export function backfillFromEvents(historyEvents: ActivityEvent[]): void {
  const candidates = historyEvents.filter(
    e =>
      e.details?.['triggeredBy'] === 'nightly' &&
      Array.isArray(e.details?.['testResults']) &&
      !seenIds.has(e.id),
  );

  if (!candidates.length) {
    console.log('[nightly-reports] Back-fill: no new events found');
    return;
  }

  for (const ev of candidates) {
    const report = buildFromEvent(ev);
    if (!report) continue;
    reports.push(report);
    seenIds.add(ev.id);
  }

  reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (reports.length > MAX_REPORTS) reports.splice(MAX_REPORTS);
  saveToDisk();
  console.log(`[nightly-reports] Back-filled ${candidates.length} report(s) from activity log`);
}

/** Return all reports, newest first. */
export function getReports(): NightlyReport[] {
  return reports;
}
