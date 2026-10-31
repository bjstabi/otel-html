import { type ApiJob, apiHeaders, messageOf } from './github-api.js';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The job's log text, or undefined (after `warn`) when it cannot be had. The API answers 302 to a signed URL; that
 * hop is made without the Authorization header, and only to https.
 */
export async function fetchJobLog(i: {
  fetch: Fetch;
  apiUrl: string;
  repository: string;
  job: ApiJob;
  token: string | undefined;
  warn: (message: string) => void;
}): Promise<string | undefined> {
  const none = (why: string): undefined => {
    i.warn(`no log for job ${i.job.name}: ${why}`);
    return undefined;
  };
  try {
    let res = await i.fetch(`${i.apiUrl}/repos/${i.repository}/actions/jobs/${i.job.id}/logs`, {
      headers: apiHeaders(i.token),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location !== null) {
      let secure = false;
      try {
        secure = new URL(location).protocol === 'https:';
      } catch {
        // an unparsable Location is refused below
      }
      if (!secure) return none('redirected to a non-https URL');
      res = await i.fetch(location, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    }
    return res.ok ? await res.text() : none(`answered ${res.status}`);
  } catch (e) {
    return none(messageOf(e));
  }
}

/**
 * Merges `inputs` (the first is the workflow trace; `optional` are job reports). One unreadable report must not sink
 * the rest: when the merge fails, each optional report is tried alone, the bad ones are skipped with a warning, and
 * the merge is retried. A failure with no bad report to blame is rethrown.
 */
export async function mergeSkippingBad<S>(i: {
  /** `probe` marks the single-report readability checks, which need no config. */
  merge: (inputs: string[], out: string, probe: boolean) => Promise<S>;
  required: string[];
  optional: string[];
  out: string;
  probeOut: (n: number) => string;
  warn: (message: string) => void;
}): Promise<{ summary: S; inputs: string[] }> {
  const all = [...i.required, ...i.optional];
  try {
    return { summary: await i.merge(all, i.out, false), inputs: all };
  } catch (first) {
    const bad: string[] = [];
    for (const [n, dir] of i.optional.entries()) {
      try {
        await i.merge([dir], i.probeOut(n), true);
      } catch (e) {
        i.warn(`skipping ${dir}: ${messageOf(e)}`);
        bad.push(dir);
      }
    }
    if (bad.length === 0) throw first;
    const inputs = all.filter((d) => !bad.includes(d));
    return { summary: await i.merge(inputs, i.out, false), inputs };
  }
}
