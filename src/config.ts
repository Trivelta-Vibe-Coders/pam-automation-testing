function require_env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional_env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: parseInt(optional_env('PORT', '8080'), 10),

  // Autosana
  autosanaApiKey:  require_env('AUTOSANA_API_KEY'),
  autosanaBaseUrl: optional_env('AUTOSANA_BASE_URL', 'https://backend.autosana.ai/api/v1'),
  autosanaAppUrl:  optional_env('AUTOSANA_APP_URL',  'https://app.autosana.ai'),

  // Environment → Autosana app_id mapping
  autosanaEnvMap: {
    staging: optional_env('AUTOSANA_APP_ID_STAGING', 'rebet-stg-pam'),
    dev:     optional_env('AUTOSANA_APP_ID_DEV',     'dev-pam'),
  } as Record<string, string>,

  // PAM suite IDs
  suites: {
    'PAM Affiliates':     optional_env('SUITE_ID_AFFILIATES',     '14fb0e17-faf3-487e-ae18-9ca01dde84c5'),
    'PAM Users Tab':      optional_env('SUITE_ID_USERS_TAB',      '615d740d-bb78-417b-8eaa-052f82dffe0d'),
    'PAM Casino Reports': optional_env('SUITE_ID_CASINO_REPORTS', '78b9916f-2d93-4af3-9739-98a5bae1d57a'),
    'PAM Agent Audit Log':optional_env('SUITE_ID_AGENT_AUDIT_LOG','d489f392-5d20-4689-87ff-e8b2e0b7f0e4'),
  } as Record<string, string>,

  // Jira status names that trigger test runs
  jiraStatusDev: optional_env('JIRA_STATUS_DEV', 'Dev'),
  jiraStatusStg: optional_env('JIRA_STATUS_STG', 'Stg'),

  // Jira
  jiraBaseUrl:   require_env('JIRA_BASE_URL'),   // e.g. https://trivelta.atlassian.net
  jiraEmail:     require_env('JIRA_EMAIL'),
  jiraApiToken:  require_env('JIRA_API_TOKEN'),
  jiraProject:   optional_env('JIRA_PROJECT', 'PAMENG'),
  jiraWebhookSecret: optional_env('JIRA_WEBHOOK_SECRET'),  // optional HMAC secret

  // Anthropic
  anthropicApiKey: require_env('ANTHROPIC_API_KEY'),
  claudeModel:     optional_env('CLAUDE_MODEL', 'claude-haiku-4-5'),

  // Semantic match threshold (0–100)
  matchThreshold: parseInt(optional_env('MATCH_THRESHOLD', '70'), 10),

  // Data directory for flow-link persistence
  dataDir: optional_env('DATA_DIR', '/app/data'),

  // Slack
  slackWebhookUrl: optional_env('SLACK_WEBHOOK_URL'),  // also used by pam_report.py

  // GitHub Actions dispatch (for post-run Slack reports)
  githubToken: optional_env('GITHUB_DISPATCH_TOKEN'),  // required for Slack results
  githubRepo:  optional_env('GITHUB_REPO', 'Trivelta-Vibe-Coders/pam-automation-testing'),
} as const;
