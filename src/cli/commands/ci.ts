import type { Command } from 'commander';
import { resolveDeps } from '../../api/report.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { WriterDeps } from '../../writer/session.js';
import { runContext } from '../ci/context-main.js';
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
    .option('--retention <n>', 'runs kept per workflow channel', '30')
    .option('--pr-retention <n>', "runs kept per pull request's branch channel", '20')
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
    .description("remove a closed pull request's branch reports from the site folder")
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
        await runCleanup(opts, io);
      } catch (e) {
        say(io, `::error::otel-html cleanup: ${messageOf(e)}`);
        throw new CliExit(1);
      }
    });
}
