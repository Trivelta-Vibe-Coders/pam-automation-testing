// ─── Jira Webhook ─────────────────────────────────────────────────────────────

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraStatus {
  id: string;
  name: string;
}

export interface JiraIssueFields {
  summary: string;
  description: AdfDocument | null;
  status: JiraStatus;
  issuetype: { id: string; name: string };
  priority: { name: string } | null;
  labels: string[];
  components: Array<{ id: string; name: string }>;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  created: string;
  updated: string;
  // common custom fields
  [key: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraChangelogItem {
  field: string;
  fieldtype: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface JiraWebhookPayload {
  webhookEvent: string;
  issue: JiraIssue;
  user?: JiraUser;
  changelog?: { items: JiraChangelogItem[] };
  timestamp?: number;
}

// ─── Atlassian Document Format (ADF) ─────────────────────────────────────────

export interface AdfDocument {
  type: 'doc';
  version: number;
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

// ─── Autosana ─────────────────────────────────────────────────────────────────

export interface AutosanaFlow {
  id: string;
  name: string;
  instructions: string;
  suite_id: string;
  created_at: string;
  updated_at: string;
}

export interface AutosanaSuite {
  id: string;
  name: string;
  description?: string;
  auth_instructions?: string | null;
  setup_flow_id?: string | null;
}

export interface AutosanaRunResult {
  batch_id: string;
  flow_run_count: number;
}

// ─── Agent internals ──────────────────────────────────────────────────────────

export interface FlowMatch {
  flow: AutosanaFlow;
  score: number;      // 0–100
  reason: string;
}

export interface FlowLink {
  jiraKey: string;
  flowId: string;
  flowName: string;
  suiteId: string;
  createdAt: string;
  updatedAt: string;
}

export type ActivityLevel = 'info' | 'success' | 'warning' | 'error';

export interface ActivityEvent {
  id: string;
  timestamp: string;
  level: ActivityLevel;
  message: string;
  details?: Record<string, unknown>;
}
