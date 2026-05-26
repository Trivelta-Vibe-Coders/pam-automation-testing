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
  suiteIds?: string[];     // if omitted, trigger all 4 PAM suites
  flowIds?: string[];      // optional flow-level filter
  jiraKey?: string;        // for logging
}

export interface TriggerResult {
  batchId: string;
  flowRunCount: number;
  appId: string;
  environment: TriggerEnvironment;
}

/**
 * Trigger PAM test suites against the specified environment.
 * Returns the batch_id so the caller can optionally poll for status.
 */
export async function triggerFlows(opts: TriggerOptions): Promise<TriggerResult> {
  const appId = config.autosanaEnvMap[opts.environment];
  if (!appId) {
    throw new Error(`No Autosana app_id configured for environment "${opts.environment}"`);
  }

  const suiteIds = opts.suiteIds ?? Object.values(config.suites);

  logger.info(
    `Triggering ${suiteIds.length} suite(s) against ${opts.environment}`,
    {
      environment: opts.environment,
      appId,
      suiteIds,
      flowIds: opts.flowIds,
      jiraKey: opts.jiraKey,
    },
  );

  const result = await triggerRun({
    app_id:    appId,
    suite_ids: suiteIds,
    flow_ids:  opts.flowIds,
  });

  logger.success(
    `Run triggered — batch_id: ${result.batch_id} (${result.flow_run_count} flows)`,
    { batchId: result.batch_id, jiraKey: opts.jiraKey },
  );

  return {
    batchId:       result.batch_id,
    flowRunCount:  result.flow_run_count,
    appId,
    environment:   opts.environment,
  };
}
