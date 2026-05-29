/**
 * Nightly regression trigger.
 *
 * Schedules a full PAM test run against staging every night.
 * The schedule is controlled by the NIGHTLY_CRON env var
 * (default: 2:00 AM UTC every day).
 *
 * Set NIGHTLY_CRON='' or NIGHTLY_ENABLED=false to disable.
 */
import cron from 'node-cron';
import * as logger from '../logger';
import { triggerFlows } from './autosana-trigger';
import { startPolling } from './batch-poller';

const DEFAULT_SCHEDULE = '0 2 * * *'; // 02:00 UTC daily

export function scheduleNightlyRun(): void {
  const enabled  = (process.env['NIGHTLY_ENABLED'] ?? 'true').toLowerCase();
  if (enabled === 'false' || enabled === '0') {
    logger.info('Nightly run disabled (NIGHTLY_ENABLED=false)');
    return;
  }

  const schedule = process.env['NIGHTLY_CRON'] ?? DEFAULT_SCHEDULE;

  if (!cron.validate(schedule)) {
    logger.warn(`Invalid NIGHTLY_CRON expression "${schedule}" — nightly run not scheduled`);
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      logger.info('Nightly regression run starting', { environment: 'staging', schedule });

      try {
        const result = await triggerFlows({
          environment: 'staging',
          jiraKey:     'nightly',
        });

        startPolling({
          batchId:     result.batchId,
          environment: 'staging',
          triggeredBy: 'nightly',
        });

        logger.success(
          `Nightly run triggered — batch ${result.batchId} (${result.flowRunCount} flows)`,
          { batchId: result.batchId, flowRunCount: result.flowRunCount },
        );
      } catch (err) {
        logger.error('Nightly run failed to trigger', { error: String(err) });
      }
    },
    { timezone: 'UTC' },
  );

  logger.info(`Nightly run scheduled: "${schedule}" UTC`, { schedule });
}
