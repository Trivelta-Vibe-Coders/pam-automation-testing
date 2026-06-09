/**
 * Jira REST API v3 client (Cloud).
 * Used to add comments / remote links back to tickets after flow create/trigger.
 */
import { config } from '../config';
import { JiraIssue } from '../types';

// ── HTTP helper ───────────────────────────────────────────────────────────────

const basicAuth = Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64');

async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.jiraBaseUrl}/rest/api/3${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Jira ${res.status} ${method} ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : ({} as T);
}

// ── Issues ────────────────────────────────────────────────────────────────────

export async function getIssue(issueKey: string): Promise<JiraIssue> {
  return api<JiraIssue>('GET', `/issue/${encodeURIComponent(issueKey)}`);
}

/**
 * Search Jira issues using JQL.
 * Returns up to `maxResults` issues (default 100).
 */
export async function searchIssues(
  jql: string,
  fields: string[] = ['summary', 'status'],
  maxResults = 100,
): Promise<JiraIssue[]> {
  const data = await api<{ issues?: JiraIssue[] }>('POST', '/search', {
    jql,
    fields,
    maxResults,
  });
  return data.issues ?? [];
}

// ── Comments ──────────────────────────────────────────────────────────────────

/**
 * Post a plain-text comment to a Jira issue using ADF format.
 */
export async function addComment(issueKey: string, text: string): Promise<void> {
  await api('POST', `/issue/${encodeURIComponent(issueKey)}/comment`, {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text }],
        },
      ],
    },
  });
}

// ── Remote Links (links issue to Autosana) ────────────────────────────────────

export async function addRemoteLink(
  issueKey: string,
  url: string,
  title: string,
): Promise<void> {
  await api('POST', `/issue/${encodeURIComponent(issueKey)}/remotelink`, {
    object: {
      url,
      title,
      icon: {
        url16x16: 'https://autosana.ai/favicon.ico',
        title:    'Autosana',
      },
    },
  });
}

// ── Webhook registration ──────────────────────────────────────────────────────

export interface JiraWebhookRegistration {
  id: number;
  name: string;
  url: string;
  events: string[];
  jqlFilter: string;
  enabled: boolean;
}

export async function listWebhooks(): Promise<JiraWebhookRegistration[]> {
  const data = await api<{ values?: JiraWebhookRegistration[] }>('GET', '/webhook');
  return data.values ?? [];
}

export async function registerWebhook(params: {
  name: string;
  url: string;
  events: string[];
  jqlFilter: string;
}): Promise<{ createdWebhookId: number }> {
  return api<{ createdWebhookId: number }>('POST', '/webhook', {
    webhooks: [
      {
        jqlFilter: params.jqlFilter,
        events:    params.events,
        url:       params.url,
      },
    ],
  });
}
