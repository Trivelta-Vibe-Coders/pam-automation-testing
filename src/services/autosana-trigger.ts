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

  // When specific flow_ids are provided, omit suite_ids entirely.
  // Autosana automatically resolves each flow's suite auth instructions when
  // triggered by flow_id — passing suite_ids alongside flow_ids causes the
  // entire suite(s) to run rather than just the selected flows.
  //
  // When no flow_ids are given (Jira trigger or full-suite run), fall back to
  // the supplied suite list or all 4 PAM suites.
  const suiteIds: string[] | undefined = opts.flowIds?.length
    ? undefined
    : (opts.suiteIds ?? Object.values(config.suites));

  if (suiteIds) {
    logger.info(
      `Triggering ${suiteIds.length} suite(s) against ${opts.environment}`,
      { environment: opts.environment, appId, suiteIds, jiraKey: opts.jiraKey },
    );
  } else {
    logger.info(
      `Triggering ${opts.flowIds!.length} specific flow(s) against ${opts.environment}`,
      { environment: opts.environment, appId, flowIds: opts.flowIds, jiraKey: opts.jiraKey },
    );
  }

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
