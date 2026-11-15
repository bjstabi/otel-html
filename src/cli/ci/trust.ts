import type { ApiRun } from './github-api.js';

/**
 * The one rule for which runs may write the site: a run of this repository (never a fork's) that either ran on the
 * default branch for an event other than `pull_request`, or was started by a `User` (a bot's pull request, and a
 * pull request whose head branch merely is named like the default branch, do not qualify).
 */
export const isTrustedRun = (run: ApiRun, repository: string, defaultBranch: string): boolean =>
  run.head_repository?.full_name === repository &&
  ((run.head_branch === defaultBranch && run.event !== 'pull_request') || run.actor?.type === 'User');
