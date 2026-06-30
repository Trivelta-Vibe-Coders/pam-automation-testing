/**
 * Background batch poller.
 *
 * After a Test Runner run is triggered, call startPolling() with the batch_id.
 * This runs entirely in the background — it polls Autosana every 60 s (max 90 min),
 * and when the batch completes it fires a pam-suite-completed GitHub Actions dispatch
 * for each suite, which triggers pam_report.py → full Slack report with AI
 * classifications, severity buckets, and "Create Bug" buttons.
 *
 * Mirrors the logic in pam-webhook-dispatcher.js (Cloudflare Worker).
 */
import { getRunStatus } from './autosana';
import { dispatchSuiteCompleted, FlowRunResult } from './github';
import { summariseTestResults } from './ai-summarizer';
import * as flowLastRun     from './flow-last-run';
import * as nightlyReports  from './nightly-reports';
import * as suiteRegistry   from './suite-registry';
import * as logger from '../logger';

const POLL_INTERVAL_MS = 60_000;   // 60 seconds
const MAX_POLLS        = 90;        // 90 minutes max

// ── Status response types (Autosana /runs/status) ────────────────────────────

interface AutosanaRun {
  id:      string;
  name:    string;
  status:  string;   // "pass" | "fail" | "failed" | "error" | "running" | ...
  summary: string;
}

interface AutosanaRunGroup {
  name: string;   // suite name
  id?:  string;   // suite run UUID → https://autosana.ai/runs/groups/{id}
  url?: string;   // fallback URL from API (may be a backend URL)
  runs: AutosanaRun[];
}

interface BatchStatus {
  is_complete: boolean;
  run_groups:  AutosanaRunGroup[];
  summary?: {
    passed_flows: number;
    failed_flows: number;
    total_flows:  number;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseStatus(raw: string): string {
  const s = (raw || 'unknown').toLowerCase();
  if (s === 'pass')                      return 'passed';
  if (s === 'fail' || s === 'failed')    return 'failed';
  return s;
}

function suiteIdForName(name: string): string | undefined {
  return suiteRegistry.getSuiteId(name);
}

// ── Main export ───────────────────────────────────────────────────────────────

export function startPolling(params: {
  batchId:     string;
  environment: string;
  triggeredBy: string;   // "manual" | jira key
}): void {
  const { batchId, environment, triggeredBy } = params;
  const runDate = new Date().toISOString().slice(0, 10);

  logger.info(`Polling started for batch ${batchId}`, { batchId, environment, triggeredBy });

  // Run in background — no await
  void (async () => {
    for (let i = 1; i <= MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      let status: BatchStatus;
      try {
        status = await getRunStatus(batchId) as BatchStatus;
      } catch (err) {
        logger.warn(`Poll ${i}/${MAX_POLLS} error for batch ${batchId}`, { error: String(err) });
        continue;
      }

      const s = status.summary;
      logger.info(
        `Poll ${i}/${MAX_POLLS} — batch ${batchId}: complete=${status.is_complete}` +
        (s ? ` passed=${s.passed_flows} failed=${s.failed_flows}` : ''),
      );

      if (!status.is_complete) continue;

      // ── Batch finished — build results, generate AI summary, then dispatch ────
      logger.success(`Batch ${batchId} complete — dispatching Slack reports`, { batchId });

      const groups = status.run_groups ?? [];

      // Ensure the suite registry is populated before using it to filter groups
      await suiteRegistry.ensureLoaded();

      // ── Build structured results (needed for both summary + dispatch) ─────────
      const allResults = groups
        .filter(g => suiteIdForName(g.name))
        .map(g => {
          const runUrl = g.id ? `https://autosana.ai/runs/groups/${g.id}` : g.url ?? undefined;
          const runs   = g.runs ?? [];
          const passed = runs.filter(r => normaliseStatus(r.status) === 'passed').length;
          const failed = runs.filter(r => normaliseStatus(r.status) !== 'passed').length;
          const allFlowDetails = runs.map(r => ({
            name:    r.name    ?? 'Unknown',
            status:  normaliseStatus(r.status),
            summary: r.summary ?? '',
          }));
          const failedFlowDetails = allFlowDetails.filter(f => f.status !== 'passed');
          return { suiteName: g.name, runUrl, passed, failed, allFlowDetails, failedFlowDetails };
        });

      const totalPassed = allResults.reduce((s, r) => s + r.passed, 0);
      const totalFailed = allResults.reduce((s, r) => s + r.failed, 0);

      // Generate AI summary BEFORE dispatching so it can be included in Slack
      let testSummary: string | undefined;
      if (allResults.length) {
        try {
          testSummary = await summariseTestResults(allResults, triggeredBy);
        } catch {
          // Non-fatal — fall back to no summary
        }
      }

      // ── Per-suite GitHub dispatch ─────────────────────────────────────────────
      let dispatched = 0;

      for (const group of groups) {
        const suiteName = group.name;
        const suiteId   = suiteIdForName(suiteName);

        if (!suiteId) {
          logger.warn(`Unknown suite in batch results: "${suiteName}" — skipping`);
          continue;
        }

        const flows: FlowRunResult[] = (group.runs ?? []).map(run => ({
          flow_id:   run.id   ?? '',
          flow_name: run.name ?? 'Unknown',
          run: {
            status:       normaliseStatus(run.status),
            summary:      run.summary ?? '',
            issues:       [],
            last_actions: [],
          },
        }));

        // Construct the Autosana app URL for this suite run
        const runUrl = group.id
          ? `https://autosana.ai/runs/groups/${group.id}`
          : group.url ?? undefined;

        try {
          await dispatchSuiteCompleted({
            suiteId, suiteName, runDate, flows, environment, triggeredBy,
            testSummary,  // include AI summary so it appears in the Slack report
          });
          logger.success(`GitHub dispatch sent for "${suiteName}"`, {
            suiteId,
            flowCount: flows.length,
            ...(runUrl ? { runUrl } : {}),
          });
          dispatched++;
        } catch (err) {
          logger.error(`Failed to dispatch "${suiteName}"`, { error: String(err) });
        }
      }

      if (dispatched === 0) {
        logger.warn(`Batch ${batchId} complete but no suites were dispatched`);
      } else {
        logger.info(
          `${dispatched} suite(s) dispatched to GitHub Actions — Slack reports incoming`,
          { batchId, dispatched },
        );
      }

      // ── Update per-flow last-run store ───────────────────────────────────────
      if (allResults.length) {
        flowLastRun.updateFlowRuns(
          allResults.map(r => ({
            suiteName:      r.suiteName,
            runUrl:         r.runUrl,
            allFlowDetails: r.allFlowDetails,
          })),
          environment,
          new Date().toISOString(),
        );
      }

      // ── Log structured results to Railway activity log ────────────────────────
      if (allResults.length) {
        const logFn    = totalFailed === 0 ? logger.success : logger.warn;
        const resultEv = logFn(
          testSummary ?? `Test results: ${totalPassed} passed, ${totalFailed} failed`,
          { triggeredBy, batchId, environment, testResults: allResults, testSummary },
        );
        // Persist nightly run results to the dedicated nightly-reports store
        if (triggeredBy === 'nightly') {
          nightlyReports.addReport(resultEv);
        }
      }

      return;  // done — exit the polling loop
    }

    // Timed out
    logger.error(`Batch ${batchId} timed out after ${MAX_POLLS} min — no Slack report sent`, {
      batchId, environment,
    });
  })();
}
