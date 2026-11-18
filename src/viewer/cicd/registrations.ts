import type { Variable } from '../../dashboards/schema.js';
import { registerFixedScope, registerHonours, registerOpensRuns } from '../dashboards/scope.js';

/** The variable keys the CI views know (the only place besides the cicd table rows that names them). */
export const CICD_BRANCH = 'vcs.ref.head.name';
export const CICD_TRIGGER = 'cicd.pipeline.trigger';
export const CICD_JOB = 'cicd.pipeline.task.name';
export const CICD_RUNNER = 'cicd.worker.labels';
const CICD_RUN_LEVEL = new Set(['stat', 'runs-trend', 'runs', 'triggers']);

/** Spec §6: run-level views honour branch and trigger, `failures` all but runner, the rest all four. */
registerHonours('cicd', (widget, variable: Variable) => {
  if (widget.type !== 'cicd') return true;
  if (variable.key === CICD_BRANCH || variable.key === CICD_TRIGGER) return true;
  if (CICD_RUN_LEVEL.has(widget.view)) return false;
  if (variable.key === CICD_JOB) return true;
  return variable.key === CICD_RUNNER && widget.view !== 'failures';
});

registerFixedScope('cicd', (widget) =>
  widget.type === 'cicd' && widget.view === 'tests' ? 'latest run' : null,
);

registerOpensRuns('cicd');
