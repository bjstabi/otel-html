import type { ApiRun } from './github-api.js';

/**
 * The one rule for which runs may write the site: a run of this repository (never a fork's) that either ran on the
 * default branch for an event other than `pull_request`, or was started by a `User` (a bot's pull request, and a
 * pull request whose head branch merely is named like the default branch, do not qualify).
 *
 * The `site` job's `if:` in a workflow is stricter: it also skips a person's non-pull_request run on a branch other
 * than the default (a manual dispatch on a feature branch). That is harmless: such a run has no `site` job and uploads
 * nothing, so there is nothing for this rule to accept or reject.
 */
export const isTrustedRun = (run: ApiRun, repository: string, defaultBranch: string): boolean =>
  run.head_repository?.full_name === repository &&
  ((run.head_branch === defaultBranch && run.event !== 'pull_request') || run.actor?.type === 'User');
