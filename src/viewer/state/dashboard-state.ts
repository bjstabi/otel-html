import { z } from 'zod';
import type { TraceId } from '../../model/ids.js';
import { paramError, shown } from './param-error.js';
import { TraceIdParamSchema, WindowTextSchema } from './param-schemas.js';

export type LogViewMode = 'matches' | 'context';

/** The URL key `d`: everything a dashboard page keeps beyond the shared `t`. */
export interface DashboardPageState {
  /** A variable key to its value; `null` is "all" (overrides the config's default). */
  vars: Record<string, string | null>;
  /** The selection: a window (`<start>~<end>` form) and a trace, separate from the page's `t`. */
  sel: { t: string | null; trace: TraceId | null };
  /** Per-widget overrides of `follow`. */
  follow: Record<string, boolean>;
  /** Per-widget overrides of the Logs widget's view. */
  logView: Record<string, LogViewMode>;
}

export const EMPTY_DASHBOARD_STATE: DashboardPageState = {
  vars: {},
  sel: { t: null, trace: null },
  follow: {},
  logView: {},
};

export const DashboardPageStateSchema: z.ZodType<DashboardPageState> = z.strictObject({
  vars: z.record(z.string(), z.string().nullable()).default({}),
  sel: z
    .strictObject({
      t: WindowTextSchema.nullable().default(null),
      trace: TraceIdParamSchema.nullable().default(null),
    })
    .default({ t: null, trace: null }),
  follow: z.record(z.string(), z.boolean()).default({}),
  logView: z.record(z.string(), z.enum(['matches', 'context'], 'one of matches, context')).default({}),
});

/** The URL key `d`: JSON text to a state, or one error line naming the offending path (`d.sel.t`). */
export function parseDashboardParam(
  raw: string,
): { ok: true; state: DashboardPageState } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: `d: expected a JSON object, got ${shown(raw)}` };
  }
  const r = DashboardPageStateSchema.safeParse(json);
  if (r.success) return { ok: true, state: r.data };
  return { ok: false, error: paramError('d', json, r.error.issues[0]) };
}

/** True when nothing differs from the empty state; a pristine `d` is left out of the URL. */
export function isPristine(s: DashboardPageState): boolean {
  return (
    Object.keys(s.vars).length === 0 &&
    s.sel.t === null &&
    s.sel.trace === null &&
    Object.keys(s.follow).length === 0 &&
    Object.keys(s.logView).length === 0
  );
}
