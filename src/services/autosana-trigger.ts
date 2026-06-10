/**
 * Shared utility: trigger Autosana flows for a given environment.
 * Used by both ticket-updated handler and any future direct triggers.
 */
import { config } from '../config';
import { triggerRun, listFlows } from './autosana';
import * as envRestrictions from './env-restrictions';
import * as logger from '../logger';

export type TriggerEnvironment = 'staging' | 'dev' | 'production';

export interface TriggerOptions {
  environment: TriggerEnvironment;
  /** Trigger specific flows (auth instructions applied by Autosana). */
  flowIds?:  string[];
  /** Trigger full suites — used for nightly runs and "no link" fallback. */
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
 * - flowIds present  → trigger those specific flows (auth handled by Autosana)
 * - suiteIds present → trigger those suites
 * - neither          → trigger all PAM suites (full regression)
 */
export async function triggerFlows(opts: TriggerOptions): Promise<TriggerResult> {
  const appId = config.autosanaEnvMap[opts.environment];
  if (!appId) {
    throw new Error(`No Autosana app_id configured for environment "${opts.environment}"`);
  }

  let runPayload: Parameters<typeof triggerRun>[0];

  // Build flow / suite list, filtering out any env-restricted flows
  const excluded = envRestrictions.getExcludedForEnv(opts.environment);

  if (opts.flowIds?.length) {
    let flowIds = opts.flowIds;
    if (excluded.length) {
      const before = flowIds.length;
      flowIds = flowIds.filter(id => !excluded.includes(id));
      if (flowIds.length < before) {
        logger.info(
          `Skipping ${before - flowIds.length} flow(s) excluded from ${opts.environment}`,
          { environment: opts.environment, skipped: before - flowIds.length },
        );
      }
    }
    if (!flowIds.length) {
      throw new Error(`All specified flows are excluded from the ${opts.environment} environment`);
    }
    logger.info(
      `Triggering ${flowIds.length} specific flow(s) against ${opts.environment}`,
      { environment: opts.environment, appId, flowIds, jiraKey: opts.jiraKey },
    );
    runPayload = { app_id: appId, flow_ids: flowIds };
  } else {
    const suiteIds = opts.suiteIds ?? Object.values(config.suites);

    if (excluded.length) {
      // Expand suites → individual flows so we can filter out restricted ones
      logger.info(`Expanding suites to filter dev-excluded flows (${excluded.length} excluded)`);
      const allowedFlowIds: string[] = [];
      let skipped = 0;
      for (const suiteId of suiteIds) {
        try {
          const flows = await listFlows(suiteId);
          for (const f of flows) {
            if (excluded.includes(f.id)) skipped++;
            else allowedFlowIds.push(f.id);
          }
        } catch {
          // If we can't fetch a suite's flows, skip it gracefully
        }
      }
      if (skipped) {
        logger.info(
          `Skipping ${skipped} flow(s) excluded from ${opts.environment}`,
          { environment: opts.environment, skipped },
        );
      }
      if (!allowedFlowIds.length) {
        throw new Error(`All flows are excluded from the ${opts.environment} environment`);
      }
      logger.info(
        `Triggering ${allowedFlowIds.length} flow(s) against ${opts.environment} (expanded from ${suiteIds.length} suite(s))`,
        { environment: opts.environment, appId, jiraKey: opts.jiraKey },
      );
      runPayload = { app_id: appId, flow_ids: allowedFlowIds };
    } else {
      logger.info(
        `Triggering ${suiteIds.length} suite(s) against ${opts.environment}`,
        { environment: opts.environment, appId, suiteIds, jiraKey: opts.jiraKey },
      );
      runPayload = { app_id: appId, suite_ids: suiteIds };
    }
  }

  const result = await triggerRun(runPayload);

  logger.success(
    `Run triggered — batch_id: ${result.batch_id} (${result.flow_run_count} flows)`,
    { batchId: result.batch_id, jiraKey: opts.jiraKey },
  );

  return {
    batchId:      result.batch_id,
    flowRunCount: result.flow_run_count,
    appId,
    environment:  opts.environment,
  };
}
