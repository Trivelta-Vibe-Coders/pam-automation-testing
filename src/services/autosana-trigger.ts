/**
 * Shared utility: trigger Autosana flows for a given environment.
 * Used by both ticket-updated handler and any future direct triggers.
 */
import { config } from '../config';
import { triggerRun } from './autosana';
import * as logger from '../logger';

export type TriggerEnvironment = 'staging' | 'dev';

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

  if (opts.flowIds?.length) {
    logger.info(
      `Triggering ${opts.flowIds.length} specific flow(s) against ${opts.environment}`,
      { environment: opts.environment, appId, flowIds: opts.flowIds, jiraKey: opts.jiraKey },
    );
    runPayload = { app_id: appId, flow_ids: opts.flowIds };
  } else {
    const suiteIds = opts.suiteIds ?? Object.values(config.suites);
    logger.info(
      `Triggering ${suiteIds.length} suite(s) against ${opts.environment}`,
      { environment: opts.environment, appId, suiteIds, jiraKey: opts.jiraKey },
    );
    runPayload = { app_id: appId, suite_ids: suiteIds };
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
