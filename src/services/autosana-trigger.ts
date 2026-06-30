/**
 * Shared utility: trigger Autosana flows for a given environment.
 * Used by both ticket-updated handler and any future direct triggers.
 */
import { config } from '../config';
import { triggerRun, listFlows } from './autosana';
import * as suiteRegistry from './suite-registry';
import * as envRestrictions from './env-restrictions';
import * as logger from '../logger';

export type TriggerEnvironment = 'staging' | 'dev' | 'production';

export interface TriggerOptions {
  environment: TriggerEnvironment;
  /** Trigger specific flows (auth instructions applied by Autosana). */
  flowIds?:  string[];
  /** Trigger full suites — used for nightly runs. */
  suiteIds?: string[];
  jiraKey?:  string;        // for logging
}

export interface TriggerResult {
  batchId: string;
  flowRunCount: number;
  appId: string;
  environment: TriggerEnvironment;
}

/**
 * Trigger PAM tests against the specified environment.
 *
 * - flowIds present  → trigger those specific flows, filtering out env-excluded ones
 * - suiteIds present → trigger those suites, skipping any that are fully excluded;
 *                      for suites with PARTIAL exclusions, expand to per-suite flow_ids
 *                      so Autosana still groups results by suite
 * - neither          → same as suiteIds = all PAM suites (full regression)
 */
export async function triggerFlows(opts: TriggerOptions): Promise<TriggerResult> {
  const appId = config.autosanaEnvMap[opts.environment];
  if (!appId) {
    throw new Error(`No Autosana app_id configured for environment "${opts.environment}"`);
  }

  const excluded = new Set(envRestrictions.getExcludedForEnv(opts.environment));

  // ── Case 1: explicit flow list (ticket-level triggers, re-runs) ───────────────
  if (opts.flowIds?.length) {
    const flowIds = opts.flowIds.filter(id => !excluded.has(id));
    const skipped = opts.flowIds.length - flowIds.length;
    if (skipped > 0) {
      logger.info(
        `Skipping ${skipped} flow(s) excluded from ${opts.environment}`,
        { environment: opts.environment, skipped },
      );
    }
    if (!flowIds.length) {
      throw new Error(`All specified flows are excluded from the ${opts.environment} environment`);
    }
    logger.info(
      `Triggering ${flowIds.length} specific flow(s) against ${opts.environment}`,
      { environment: opts.environment, appId, flowIds, jiraKey: opts.jiraKey },
    );
    const result = await triggerRun({ app_id: appId, flow_ids: flowIds });
    logger.success(
      `Run triggered — batch_id: ${result.batch_id} (${result.flow_run_count} flows)`,
      { batchId: result.batch_id, jiraKey: opts.jiraKey },
    );
    return { batchId: result.batch_id, flowRunCount: result.flow_run_count, appId, environment: opts.environment };
  }

  // ── Case 2: suite-level triggers (nightly, full regression) ──────────────────
  await suiteRegistry.ensureLoaded();
  const suiteIds = opts.suiteIds ?? suiteRegistry.getAllSuiteIds();

  if (excluded.size === 0) {
    // No exclusions — send suite_ids directly (Autosana groups results by suite name)
    logger.info(
      `Triggering ${suiteIds.length} suite(s) against ${opts.environment}`,
      { environment: opts.environment, appId, suiteIds, jiraKey: opts.jiraKey },
    );
    const result = await triggerRun({ app_id: appId, suite_ids: suiteIds });
    logger.success(
      `Run triggered — batch_id: ${result.batch_id} (${result.flow_run_count} flows)`,
      { batchId: result.batch_id, jiraKey: opts.jiraKey },
    );
    return { batchId: result.batch_id, flowRunCount: result.flow_run_count, appId, environment: opts.environment };
  }

  // Some flows are excluded — handle per suite to preserve suite-level grouping.
  // - Suite with NO excluded flows  → keep as suite_id (Autosana groups correctly)
  // - Suite with SOME excluded flows → expand to allowed flow_ids for that suite only
  // - Suite with ALL flows excluded  → drop it entirely
  logger.info(
    `${excluded.size} flow(s) excluded from ${opts.environment} — checking per suite`,
    { environment: opts.environment },
  );

  const cleanSuiteIds: string[] = [];
  const partialFlowIds: string[] = [];
  let totalSkipped = 0;

  for (const suiteId of suiteIds) {
    let flows: Awaited<ReturnType<typeof listFlows>>;
    try {
      flows = await listFlows(suiteId);
    } catch {
      logger.warn(`Could not fetch flows for suite ${suiteId} — including as full suite`);
      cleanSuiteIds.push(suiteId);
      continue;
    }

    const allowed  = flows.filter(f => !excluded.has(f.id));
    const skipped  = flows.length - allowed.length;
    totalSkipped  += skipped;

    if (allowed.length === 0) {
      logger.info(`Suite ${suiteId} — all ${flows.length} flows excluded, skipping suite entirely`);
    } else if (skipped === 0) {
      // No exclusions in this suite — use suite_id to keep clean grouping
      cleanSuiteIds.push(suiteId);
    } else {
      // Partial exclusion — use flow_ids so excluded flows don't run;
      // Autosana still groups these under the suite name in run_groups
      logger.info(`Suite ${suiteId} — ${skipped} of ${flows.length} flow(s) excluded, using flow_ids`);
      partialFlowIds.push(...allowed.map(f => f.id));
    }
  }

  if (totalSkipped > 0) {
    logger.info(
      `Skipping ${totalSkipped} flow(s) excluded from ${opts.environment}`,
      { environment: opts.environment, skipped: totalSkipped },
    );
  }

  const hasSuites = cleanSuiteIds.length > 0;
  const hasFlows  = partialFlowIds.length > 0;

  if (!hasSuites && !hasFlows) {
    throw new Error(`All flows/suites are excluded from the ${opts.environment} environment`);
  }

  // If we have both clean suites and partial flow_ids, combine into one trigger.
  // suite_ids + flow_ids in one payload lets Autosana run them in a single batch.
  const payload: Parameters<typeof triggerRun>[0] = { app_id: appId };
  if (hasSuites)  payload.suite_ids = cleanSuiteIds;
  if (hasFlows)   payload.flow_ids  = partialFlowIds;

  logger.info(
    `Triggering ${cleanSuiteIds.length} full suite(s) + ${partialFlowIds.length} individual flow(s) against ${opts.environment}`,
    { environment: opts.environment, appId, cleanSuiteIds, partialFlowCount: partialFlowIds.length, jiraKey: opts.jiraKey },
  );

  const result = await triggerRun(payload);
  logger.success(
    `Run triggered — batch_id: ${result.batch_id} (${result.flow_run_count} flows)`,
    { batchId: result.batch_id, jiraKey: opts.jiraKey },
  );
  return { batchId: result.batch_id, flowRunCount: result.flow_run_count, appId, environment: opts.environment };
}
