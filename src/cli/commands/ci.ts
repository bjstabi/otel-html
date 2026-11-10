import type { Command } from 'commander';
import { resolveDeps } from '../../api/report.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import { runContext } from '../ci/context-main.js';
import {
  runDeployApply,
  runDeployFetch,
  runDeployFetchLive,
  runDeployPlan,
  runDeployPrune,
  runDeployScan,
} from '../ci/deploy-main.js';
import { envVar, messageOf, say } from '../ci/github-api.js';
import { runLink } from '../ci/link-main.js';
import { runReport } from '../ci/report-main.js';
import { runCleanup, runSite } from '../ci/site-main.js';
import type { CliIo } from '../io.js';
import { CliExit } from '../program.js';

interface ContextFlags {
  jobName?: string;
}

interface ReportFlags {
  runId: string;
  repository: string;
  artifacts: string;
  out: string;
  config?: string;
  summary: boolean;
}

const parseRunId = (text: string): number => parsePositive('--run-id', text);

function parsePositive(flag: string, text: string): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n <= 0)
    throw new OtelHtmlError('usage', { message: `${flag} is not a positive integer: ${text}` });
  return n;
}

function parseRepository(text: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(text))
    throw new OtelHtmlError('usage', { message: `--repository is not owner/repo: ${text}` });
  return text;
}

interface SiteFlags {
  site: string;
  report: string;
  runId: string;
  repository: string;
  baseUrl: string;
  retention: string;
  prRetention: string;
  config?: string;
}

interface LinkFlags {
  runId: string;
  repository: string;
  url: string;
  site: string;
  comment: boolean;
  check: boolean;
}

interface CleanupFlags {
  site: string;
  pr: string;
  repository?: string;
}

interface DeployApplyFlags {
  repository?: string;
  site: string;
  state?: string;
  updates: string;
  pending?: string;
  retention: string;
  prRetention: string;
  config?: string;
  passRunId?: string;
  trustUpdates?: boolean;
  channel?: string;
}

interface DeployPlanFlags {
  repository?: string;
  out: string;
  stateOut: string;
  pagesUrl: string;
  ciWorkflows: string;
  reportWorkflow: string;
}

interface DeployFetchFlags {
  repository?: string;
  pending: string;
  out: string;
}

export function addCiCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void {
  const ci = program.command('ci').description("CI dogfooding: join a workflow run's trace and report on it");
  ci.command('context')
    .description(
      'append TRACEPARENT and resource attributes for this job to $GITHUB_ENV (never fails the job)',
    )
    .option('--job-name <name>', "the job's display name (default: $OTEL_HTML_JOB_NAME or $GITHUB_JOB)")
    .action(async (flags: ContextFlags) => {
      const env = flags.jobName === undefined ? io.env : { ...io.env, OTEL_HTML_JOB_NAME: flags.jobName };
      await runContext(env, io);
    });
  ci.command('report')
    .description("build a workflow run's report from the Actions API and merge it with the job reports")
    .requiredOption('--run-id <n>', 'workflow run id')
    .requiredOption('--repository <owner/repo>', 'repository of the run')
    .requiredOption('--artifacts <dir>', 'folder of downloaded otel-html-* job artifacts')
    .requiredOption('--out <dir>', 'merged report folder')
    .option('--config <file>', 'config file for the written reports')
    .option('--no-summary', 'do not write the job summary (`ci link` writes the one with the report link)')
    .action(async (flags: ReportFlags) => {
      const opts = {
        runId: parseRunId(flags.runId),
        repository: parseRepository(flags.repository),
        artifacts: flags.artifacts,
        out: flags.out,
        stepSummary: flags.summary,
        ...(flags.config === undefined ? {} : { config: flags.config }),
      };
      try {
        await runReport(opts, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html report: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  ci.command('site')
    .description(
      "place a run's report on the checked-out site folder, apply retention and rewrite the indexes",
    )
    .requiredOption('--site <dir>', 'the site folder (the gh-pages tree)')
    .requiredOption('--report <dir>', "the run's merged report folder")
    .requiredOption('--run-id <n>', 'workflow run id')
    .requiredOption('--repository <owner/repo>', 'repository of the run')
    .requiredOption('--base-url <url>', "the site's public URL")
    .option('--retention <n>', 'runs kept per workflow in each branch channel', '30')
    .option('--pr-retention <n>', 'runs kept per workflow in each pull request channel', '10')
    .option('--config <file>', "dashboard config file for the channel's rolling report")
    .action(async (flags: SiteFlags) => {
      const opts = {
        site: flags.site,
        report: flags.report,
        runId: parseRunId(flags.runId),
        repository: parseRepository(flags.repository),
        baseUrl: flags.baseUrl,
        retention: parsePositive('--retention', flags.retention),
        prRetention: parsePositive('--pr-retention', flags.prRetention),
        ...(flags.config === undefined ? {} : { config: flags.config }),
      };
      try {
        await runSite(opts, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html site: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  ci.command('link')
    .description(
      "link a published report: sticky comment on the commit's open pull requests, a check run, the job summary (never fails the job)",
    )
    .requiredOption('--run-id <n>', 'workflow run id')
    .requiredOption('--repository <owner/repo>', 'repository of the run')
    .requiredOption('--url <url>', "the run's published report URL")
    .requiredOption('--site <dir>', 'the site folder (the gh-pages tree), for the previous run')
    .option('--no-comment', 'do not comment on pull requests')
    .option('--no-check', 'do not create a check run')
    .action(async (flags: LinkFlags) => {
      await runLink(
        {
          runId: parseRunId(flags.runId),
          repository: parseRepository(flags.repository),
          url: flags.url,
          site: flags.site,
          comment: flags.comment,
          check: flags.check,
        },
        io,
      );
    });
  ci.command('cleanup')
    .description("remove a closed pull request's reports (pr/<n>) from the site folder")
    .requiredOption('--site <dir>', 'the site folder (the gh-pages tree)')
    .requiredOption('--pr <number>', 'pull request number')
    .option('--repository <owner/repo>', 'repository, for the landing page (default: $GITHUB_REPOSITORY)')
    .action(async (flags: CleanupFlags) => {
      const repository = flags.repository ?? envVar(io, 'GITHUB_REPOSITORY');
      if (repository === undefined)
        throw new OtelHtmlError('usage', {
          message: '--repository is required when GITHUB_REPOSITORY is not set',
        });
      const opts = {
        site: flags.site,
        pr: parsePositive('--pr', flags.pr),
        repository: parseRepository(repository),
      };
      try {
        await runCleanup(opts, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html cleanup: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  const deploy = ci
    .command('deploy')
    .description('the Pages deployer: find the pending site updates and fetch them');
  const repositoryOf = (flag: string | undefined): string => {
    const repository = flag ?? envVar(io, 'GITHUB_REPOSITORY');
    if (repository === undefined)
      throw new OtelHtmlError('usage', {
        message: '--repository is required when GITHUB_REPOSITORY is not set',
      });
    return parseRepository(repository);
  };
  deploy
    .command('plan')
    .description(
      'find the last deployed site, the newest site state and the pending updates; write pending.json and the state',
    )
    .option('--repository <owner/repo>', 'repository (default: $GITHUB_REPOSITORY)')
    .requiredOption('--out <file>', 'where pending.json is written')
    .requiredOption('--state-out <dir>', "where the chosen state's files are written")
    .requiredOption('--pages-url <url>', "the site's public URL")
    .option('--ci-workflows <files>', 'comma-separated workflow files whose runs publish', 'ci.yml')
    .option('--report-workflow <file>', 'the workflow file that uploads run and PR updates', 'ci-report.yml')
    .action(async (flags: DeployPlanFlags) => {
      const opts = {
        repository: repositoryOf(flags.repository),
        out: flags.out,
        stateOut: flags.stateOut,
        pagesUrl: flags.pagesUrl,
        ciWorkflows: flags.ciWorkflows
          .split(',')
          .map((w) => w.trim())
          .filter((w) => w !== ''),
        reportWorkflow: flags.reportWorkflow,
        now: new Date().toISOString(),
      };
      try {
        await runDeployPlan(opts, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html deploy plan: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  deploy
    .command('fetch')
    .description("download the accepted updates of pending.json into <out>/<update's name>/")
    .option('--repository <owner/repo>', 'repository (default: $GITHUB_REPOSITORY)')
    .requiredOption('--pending <file>', "the plan's pending.json (rewritten when a download fails)")
    .requiredOption('--out <dir>', 'where the updates are unpacked')
    .action(async (flags: DeployFetchFlags) => {
      const opts = { repository: repositoryOf(flags.repository), pending: flags.pending, out: flags.out };
      try {
        await runDeployFetch(opts, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html deploy fetch: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  deploy
    .command('apply')
    .description(
      "apply the pending updates to the unpacked site in the spec's order, with deferred deletion, and write site-state/ (never calls the API, never deploys)",
    )
    .option('--repository <owner/repo>', 'repository (default: $GITHUB_REPOSITORY)')
    .requiredOption('--site <dir>', 'the unpacked base site, edited in place')
    .option('--state <dir>', 'the state `plan` chose; overwrites <site>/site-state/ first')
    .requiredOption('--updates <dir>', "the unpacked updates, <dir>/<update's name>/ each")
    .option('--pending <file>', "the plan's pending.json (optional with --trust-updates)")
    .option('--retention <n>', 'runs kept per workflow in each branch channel', '30')
    .option('--pr-retention <n>', 'runs kept per workflow in each pull request channel', '10')
    .option('--config <file>', 'the dashboard config file for the rolling reports')
    .option('--pass-run-id <n>', 'this deployer run id (default: $GITHUB_RUN_ID)')
    .option('--trust-updates', 'TEST ONLY: apply every update folder under --updates without pending.json')
    .option('--channel <key>', 'TEST ONLY: with --trust-updates, the channel (branch/<slug> or pr/<n>)')
    .action(async (flags: DeployApplyFlags) => {
      try {
        const passRun = flags.passRunId ?? envVar(io, 'GITHUB_RUN_ID');
        if (passRun === undefined)
          throw new OtelHtmlError('usage', {
            message: '--pass-run-id is required when GITHUB_RUN_ID is not set',
          });
        if (flags.trustUpdates === true && flags.channel === undefined)
          throw new OtelHtmlError('usage', { message: '--trust-updates needs --channel' });
        if (flags.trustUpdates !== true && flags.pending === undefined)
          throw new OtelHtmlError('usage', { message: '--pending is required without --trust-updates' });
        const opts = {
          site: flags.site,
          updates: flags.updates,
          repository: repositoryOf(flags.repository),
          retention: parsePositive('--retention', flags.retention),
          prRetention: parsePositive('--pr-retention', flags.prRetention),
          passRunId: parsePositive('--pass-run-id', passRun),
          now: new Date().toISOString(),
          ...(flags.state === undefined ? {} : { state: flags.state }),
          ...(flags.pending === undefined ? {} : { pending: flags.pending }),
          ...(flags.config === undefined ? {} : { config: flags.config }),
          ...(flags.trustUpdates === true && flags.channel !== undefined
            ? { trust: { channel: flags.channel } }
            : {}),
        };
        await runDeployApply(opts, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html deploy apply: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  deploy
    .command('prune')
    .description(
      'delete the artifacts of deployments older than the newest --keep, and the update artifacts they consumed (needs a write token)',
    )
    .option('--repository <owner/repo>', 'repository (default: $GITHUB_REPOSITORY)')
    .requiredOption('--site <dir>', 'the deployed site, whose site-state/applied.json says what was consumed')
    .option('--keep <n>', 'successful deployments whose artifacts are kept', '3')
    .action(async (flags: { repository?: string; site: string; keep: string }) => {
      try {
        await runDeployPrune(
          {
            site: flags.site,
            repository: repositoryOf(flags.repository),
            keep: parsePositive('--keep', flags.keep),
            now: new Date().toISOString(),
          },
          io,
          await resolveDeps(deps),
        );
      } catch (e) {
        say(io, `::error::otel-html deploy prune: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  deploy
    .command('fetch-live')
    .description(
      "cold start: download the live site's files, as listed by its site-state/files.json, into <out>",
    )
    .requiredOption('--pages-url <url>', "the site's public URL")
    .requiredOption('--out <dir>', 'where the site is written')
    .action(async (flags: { pagesUrl: string; out: string }) => {
      try {
        await runDeployFetchLive(flags, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html deploy fetch-live: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
  deploy
    .command('scan')
    .description(
      'rewrite <site>/site-state/files.json from the files now in the site (after the preview step)',
    )
    .requiredOption('--site <dir>', 'the site')
    .action(async (flags: { site: string }) => {
      try {
        await runDeployScan(flags, io, await resolveDeps(deps));
      } catch (e) {
        say(io, `::error::otel-html deploy scan: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
}
