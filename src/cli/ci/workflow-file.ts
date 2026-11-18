import { parse } from 'yaml';
import { apiHeaders, type Fetch } from './github-api.js';

/** One job of a workflow file: what the Actions API does not say about it. */
export interface WorkflowJob {
  id: string;
  name: string | null;
  needs: string[];
  condition: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const field = (r: Record<string, unknown> | undefined, key: string): unknown => r?.[key];

/** The jobs of a workflow file in file order; text that is not a workflow has none. */
export function parseWorkflow(text: string): WorkflowJob[] {
  const jobs = asRecord(field(asRecord(parse(text)), 'jobs'));
  if (jobs === undefined) return [];
  return Object.entries(jobs).map(([id, raw]) => {
    const job = asRecord(raw) ?? {};
    const name = field(job, 'name');
    const needs = field(job, 'needs');
    const cond = field(job, 'if');
    return {
      id,
      name: typeof name === 'string' ? name : null,
      needs: typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs.map(String) : [],
      condition: cond === undefined || cond === null ? null : String(cond),
    };
  });
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The workflow job an API job name came from: a `name:` with each `${{ … }}` as a wildcard, or, without one, the
 * id itself or `<id> (` as a prefix (a matrix entry). The first match in file order wins.
 */
export function matchJob(jobs: readonly WorkflowJob[], apiName: string): WorkflowJob | null {
  for (const job of jobs) {
    if (job.name !== null) {
      const pattern = job.name
        .split(/\$\{\{.*?\}\}/s)
        .map(escapeRegExp)
        .join('.*');
      if (new RegExp(`^${pattern}$`, 's').test(apiName)) return job;
    } else if (apiName === job.id || apiName.startsWith(`${job.id} (`)) return job;
  }
  return null;
}

/** The text of a workflow file at `ref`, from the contents API. Throws on a non-2xx answer. */
export async function fetchWorkflowFile(o: {
  fetch: Fetch;
  apiUrl: string;
  repository: string;
  path: string;
  ref: string;
  token: string | undefined;
}): Promise<string> {
  const url = `${o.apiUrl}/repos/${o.repository}/contents/${o.path}?ref=${encodeURIComponent(o.ref)}`;
  const res = await o.fetch(url, { headers: apiHeaders(o.token), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = (await res.json()) as { content?: string };
  if (typeof body.content !== 'string') throw new Error(`${url} has no content`);
  return Buffer.from(body.content, 'base64').toString('utf8');
}
