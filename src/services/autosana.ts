/**
 * Autosana REST API client.
 * Docs: https://docs.autosana.ai/api-runs
 */
import { config } from '../config';
import { AutosanaFlow, AutosanaSuite, AutosanaRunResult } from '../types';

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.autosanaBaseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-API-Key':    config.autosanaApiKey,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Autosana ${res.status} ${method} ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : ({} as T);
}

// ── Suites ────────────────────────────────────────────────────────────────────

export async function listSuites(): Promise<AutosanaSuite[]> {
  const data = await api<{ suites?: AutosanaSuite[]; data?: AutosanaSuite[] }>('GET', '/suites');
  return data.suites ?? data.data ?? (data as unknown as AutosanaSuite[]);
}

// ── Flows ─────────────────────────────────────────────────────────────────────

export async function listFlows(suiteId: string): Promise<AutosanaFlow[]> {
  const data = await api<{ flows?: AutosanaFlow[]; data?: AutosanaFlow[] }>(
    'GET',
    `/flows?suite_id=${encodeURIComponent(suiteId)}`,
  );
  return data.flows ?? data.data ?? (data as unknown as AutosanaFlow[]);
}

export async function listAllPamFlows(): Promise<AutosanaFlow[]> {
  const allFlows: AutosanaFlow[] = [];
  await Promise.all(
    Object.entries(config.suites).map(async ([, suiteId]) => {
      try {
        const flows = await listFlows(suiteId);
        allFlows.push(...flows);
      } catch {
        // ignore missing suites
      }
    }),
  );
  return allFlows;
}

export async function createFlow(params: {
  name: string;
  instructions: string;
  suite_id: string;
}): Promise<AutosanaFlow> {
  const data = await api<{ flow?: AutosanaFlow } | AutosanaFlow>('POST', '/flows', params);
  return ('flow' in data && data.flow) ? data.flow : (data as AutosanaFlow);
}

export async function updateFlow(
  flowId: string,
  params: { name?: string; instructions?: string },
): Promise<AutosanaFlow> {
  const data = await api<{ flow?: AutosanaFlow } | AutosanaFlow>(
    'PATCH',
    `/flows/${encodeURIComponent(flowId)}`,
    params,
  );
  return ('flow' in data && data.flow) ? data.flow : (data as AutosanaFlow);
}

export async function getFlow(flowId: string): Promise<AutosanaFlow> {
  const data = await api<{ flow?: AutosanaFlow } | AutosanaFlow>(
    'GET',
    `/flows/${encodeURIComponent(flowId)}`,
  );
  return ('flow' in data && data.flow) ? data.flow : (data as AutosanaFlow);
}

// ── Runs ──────────────────────────────────────────────────────────────────────

/**
 * Trigger one or more suites against an environment.
 * Returns a batch_id you can poll with getRunStatus().
 */
export async function triggerRun(params: {
  app_id: string;
  suite_ids?: string[];   // run full suites; omit when flow_ids is specified
  flow_ids?: string[];    // run specific flows (auth resolved per flow automatically)
}): Promise<AutosanaRunResult> {
  return api<AutosanaRunResult>('POST', '/flows/run', params);
}

export async function getRunStatus(batchId: string): Promise<unknown> {
  return api<unknown>('GET', `/runs/status?batch_id=${encodeURIComponent(batchId)}`);
}
