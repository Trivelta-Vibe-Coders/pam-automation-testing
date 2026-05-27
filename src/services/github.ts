/**
 * GitHub Actions repository_dispatch client.
 * Fires the same pam-suite-completed event that the Cloudflare Worker uses,
 * so manual Test Runner runs go through the same pam_report.py pipeline
 * and produce the same rich Slack report.
 */
import { config } from '../config';

export interface FlowRunResult {
  flow_id:   string;
  flow_name: string;
  run: {
    status:       string;   // "passed" | "failed" | "error"
    summary:      string;
    issues:       string[];
    last_actions: string[];
  };
}

export async function dispatchSuiteCompleted(params: {
  suiteId:     string;
  suiteName:   string;
  runDate:     string;
  flows:       FlowRunResult[];
  environment: string;
}): Promise<void> {
  if (!config.githubToken) {
    throw new Error('GITHUB_DISPATCH_TOKEN not set — cannot dispatch to GitHub Actions');
  }

  const url  = `https://api.github.com/repos/${config.githubRepo}/dispatches`;
  const body = {
    event_type:     'pam-suite-completed',
    client_payload: {
      suite_id:    params.suiteId,
      suite_name:  params.suiteName,
      run_date:    params.runDate,
      flows:       params.flows,
      environment: params.environment,
    },
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `token ${config.githubToken}`,
      Accept:         'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent':   'pam-qa-agent/1.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch ${res.status}: ${text}`);
  }
}
