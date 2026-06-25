/**
 * Test Runner API
 *
 * GET  /api/suites-with-flows  → all 4 PAM suites + their flows (cached 5 min)
 * POST /api/run                → trigger selected flows in parallel
 */
import { Router, Request, Response } from 'express';
import { listFlows } from '../services/autosana';
import { triggerFlows, TriggerEnvironment } from '../services/autosana-trigger';
import { startPolling } from '../services/batch-poller';
import * as suiteRegistry from '../services/suite-registry';
import * as logger from '../logger';

export const runnerRouter = Router();

// ── Suite+flow cache ──────────────────────────────────────────────────────────

interface FlowSummary {
  id:   string;
  name: string;
}

interface SuiteWithFlows {
  suite_id:   string;
  suite_name: string;
  flows:      FlowSummary[];
}

let cache: SuiteWithFlows[] | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getSuitesWithFlows(): Promise<SuiteWithFlows[]> {
  if (cache && Date.now() < cacheExpiry) return cache;

  const results = await Promise.all(
    suiteRegistry.getAllSuites().map(async ({ name: suiteName, id: suiteId }) => {
      try {
        const flows = await listFlows(suiteId);
        return {
          suite_id:   suiteId,
          suite_name: suiteName,
          flows: flows.map(f => ({ id: f.id, name: f.name })),
        };
      } catch (err) {
        logger.warn(`Could not fetch flows for suite "${suiteName}"`, { error: String(err) });
        return { suite_id: suiteId, suite_name: suiteName, flows: [] };
      }
    }),
  );

  results.sort((a, b) => a.suite_name.localeCompare(b.suite_name));

  cache      = results;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return results;
}

// ── Routes ────────────────────────────────────────────────────────────────────

runnerRouter.get('/suites-with-flows', async (_req: Request, res: Response) => {
  try {
    const data = await getSuitesWithFlows();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

runnerRouter.post('/run', async (req: Request, res: Response) => {
  const environment        = (req.body?.environment ?? 'staging') as TriggerEnvironment;
  const suiteIds: string[] = req.body?.suite_ids ?? [];
  const flowIds:  string[] = req.body?.flow_ids  ?? [];

  if (!suiteIds.length && !flowIds.length) {
    res.status(400).json({ error: 'No suites or flows selected' });
    return;
  }

  const isFlowRun = flowIds.length > 0;

  if (isFlowRun) {
    logger.info(
      `Manual run triggered: ${flowIds.length} specific flow(s) on ${environment}`,
      { flowIds, environment },
    );
  } else {
    logger.info(
      `Manual run triggered: ${suiteIds.length} suite(s) on ${environment}`,
      { suiteIds, environment },
    );
  }

  try {
    const result = await triggerFlows(
      isFlowRun
        ? { environment, flowIds }
        : { environment, suiteIds },
    );

    // Start background polling → dispatches GitHub Actions → Slack report when done
    startPolling({ batchId: result.batchId, environment, triggeredBy: 'manual' });

    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('Manual run failed', { error: String(err) });
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Bust the cache (useful after flows are created/updated by the agent)
runnerRouter.post('/refresh-flows', (_req: Request, res: Response) => {
  cache      = null;
  cacheExpiry = 0;
  res.json({ ok: true });
});
