import { spawn } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import type { CliDeps } from '../../src/cli/commands/receive.js';
import { runCli } from '../../src/cli/program.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import { manifestOf, spansRequest } from '../writer/helpers.js';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  w: TestWriter,
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
  extra: CliDeps = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(
    argv,
    {
      stdout: (s) => {
        stdout += s;
      },
      stderr: (s) => {
        stderr += s;
      },
      env,
      cwd: '/work',
      signals: { on: () => () => undefined },
      spawn,
    },
    { ...w.deps, ...extra },
  );
  return { code, stdout, stderr };
}

const enc = new TextEncoder();
async function put(w: TestWriter, path: string, text: string | Uint8Array): Promise<void> {
  await w.fs.writeBytes(path, typeof text === 'string' ? enc.encode(text) : text);
}

describe('cli', () => {
  test('convert writes a report and prints the totals with thousands separators', async () => {
    const w = createTestWriter();
    await put(w, 'in/small.otlp.json', JSON.stringify(spansRequest(1234)));
    const r = await run(w, ['convert', 'in/small.otlp.json', '-o', 'out']);
    expect(r).toEqual({ code: 0, stdout: 'wrote out: 1,234 spans, 0 logs, 0 metric points\n', stderr: '' });
    expect(manifestOf(w, 'out').complete).toBe(true);
  });

  test('convert of a trace-only input does not favour heap size', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    let calls = 0;
    const r = await run(w, ['convert', 'in/a.json', '-o', 'out'], {}, { favourShortPauses: () => calls++ });
    expect(r.code).toBe(0);
    expect(calls).toBe(0);
  });

  test('convert combines several files and applies --title', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(w, 'in/b.json', JSON.stringify(logsRequest([logRecord(), logRecord(), logRecord()])));
    const r = await run(w, ['convert', 'in/a.json', 'in/b.json', '-o', 'out', '--title', 'My run']);
    expect(r.stdout).toBe('wrote out: 2 spans, 3 logs, 0 metric points\n');
    expect(manifestOf(w, 'out').title).toBe('My run');
  });

  test('convert with no files is a usage error', async () => {
    const w = createTestWriter();
    const r = await run(w, ['convert', '-o', 'out']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('error: no input files');
    expect(r.stdout).toBe('');
  });

  test('a protobuf input without --signal is a usage error naming the hint', async () => {
    const w = createTestWriter();
    await put(w, 'in/c.pb', new Uint8Array([]));
    const r = await run(w, ['convert', 'in/c.pb', '-o', 'out']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: .*in\/c\.pb/);
    expect(r.stderr).toContain('--signal traces|logs|metrics');
  });

  test('--signal takes only the three signals', async () => {
    const w = createTestWriter();
    const r = await run(w, ['convert', 'x.pb', '-o', 'out', '--signal', 'spans']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('spans');
  });

  test('--append reopens an existing report', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(w, 'in/b.json', JSON.stringify(spansRequest(3, 0, 10)));
    await run(w, ['convert', 'in/a.json', '-o', 'out']);
    const r = await run(w, ['convert', 'in/b.json', '-o', 'out', '--append']);
    expect(r.stdout).toBe('wrote out: 5 spans, 0 logs, 0 metric points\n');
  });

  test('convert into an existing report appends; --replace starts over; --append needs a report', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(w, 'in/b.json', JSON.stringify(spansRequest(3, 0, 10)));
    await run(w, ['convert', 'in/a.json', '-o', 'out']);
    const appended = await run(w, ['convert', 'in/b.json', '-o', 'out']);
    expect(appended.stdout).toBe('wrote out: 5 spans, 0 logs, 0 metric points\n');
    const replaced = await run(w, ['convert', 'in/b.json', '-o', 'out', '--replace']);
    expect(replaced.stdout).toBe('wrote out: 3 spans, 0 logs, 0 metric points\n');
    const missing = await run(w, ['convert', 'in/b.json', '-o', 'fresh', '--append']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('error: ');
    expect(missing.stderr).toContain('cannot append');
    expect(await w.fs.exists('fresh')).toBe(false);
  });

  test('--append with --replace exits 2', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    const both = ['-o', 'out', '--append', '--replace'];
    for (const argv of [
      ['convert', 'in/a.json', ...both],
      ['merge', 'in', ...both],
      ['serve', ...both],
      ['run', ...both, '--', 'true'],
    ]) {
      const r = await run(w, argv);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('cannot be used with');
    }
    expect(await w.fs.exists('out')).toBe(false);
  });

  test('merge into an existing report at -o adds to it', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(w, 'in/b.json', JSON.stringify(spansRequest(3, 0, 10)));
    await run(w, ['convert', 'in/a.json', '-o', 'one']);
    await run(w, ['convert', 'in/b.json', '-o', 'out']);
    const r = await run(w, ['merge', 'one', '-o', 'out']);
    expect(r).toEqual({ code: 0, stdout: 'wrote out: 5 spans, 0 logs, 0 metric points\n', stderr: '' });
  });

  test('merge combines reports', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(w, 'in/b.json', JSON.stringify(spansRequest(3, 0, 10)));
    await run(w, ['convert', 'in/a.json', '-o', 'one']);
    await run(w, ['convert', 'in/b.json', '-o', 'two']);
    const r = await run(w, ['merge', 'one', 'two', '-o', 'both']);
    expect(r).toEqual({ code: 0, stdout: 'wrote both: 5 spans, 0 logs, 0 metric points\n', stderr: '' });
  });

  test('a library failure prints error: without a stack', async () => {
    const w = createTestWriter();
    const r = await run(w, ['merge', 'nowhere', '-o', 'both']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no report found at nowhere');
    const bad = await run(w, ['convert', 'missing.json', '-o', 'out']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('cannot read input file missing.json');
    expect(bad.stderr).not.toContain('    at ');
  });

  test('invalid input exits 2 and unexpected failures exit 1', async () => {
    const w = createTestWriter();
    await put(w, 'in/bad.json', '{"resourceSpans": 5}');
    const invalid = await run(w, ['convert', 'in/bad.json', '-o', 'out']);
    expect(invalid.code).toBe(2);
    await put(w, 'in/gz.json', new Uint8Array([0x1f, 0x8b, 1]));
    const unsupported = await run(w, ['convert', 'in/gz.json', '-o', 'out2']);
    expect(unsupported.code).toBe(1);
    expect(unsupported.stderr).toContain('error: ');
  });

  test('OTEL_HTML_DEBUG=1 adds the stack', async () => {
    const w = createTestWriter();
    await put(w, 'in/gz.json', new Uint8Array([0x1f, 0x8b, 1]));
    const r = await run(w, ['convert', 'in/gz.json', '-o', 'out'], { OTEL_HTML_DEBUG: '1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('    at ');
  });

  test('an unknown flag exits 2 and says which', async () => {
    const w = createTestWriter();
    const r = await run(w, ['convert', 'a.json', '-o', 'out', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown option '--bogus'");
  });

  test('a missing required -o exits 2', async () => {
    const w = createTestWriter();
    const r = await run(w, ['convert', 'a.json']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--out');
  });

  test('--help lists the commands and exits 0', async () => {
    const w = createTestWriter();
    const r = await run(w, ['--help']);
    expect(r.code).toBe(0);
    for (const name of ['convert', 'merge', 'config']) expect(r.stdout).toContain(name);
  });

  test('config print shows defaults and the flag that won', async () => {
    const w = createTestWriter();
    const r = await run(w, ['config', 'print', '--title', 'x']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('title: x # from: flag');
    expect(r.stdout).toContain('# from: default');
  });

  test('config print layers file < env < flag', async () => {
    const w = createTestWriter();
    await put(w, '/work/otel-html.yaml', 'title: from file\nviewer:\n  eagerBudgetBytes: 1000\n');
    const fileOnly = await run(w, ['config', 'print']);
    expect(fileOnly.stdout).toContain('title: from file # from: file');
    const env = await run(w, ['config', 'print'], { OTEL_HTML_TITLE: 'from env' });
    expect(env.stdout).toContain('title: from env # from: env');
    expect(env.stdout).toContain('eagerBudgetBytes: 1000 # from: file');
    const flag = await run(w, ['config', 'print', '--title', 'f'], { OTEL_HTML_TITLE: 'from env' });
    expect(flag.stdout).toContain('title: f # from: flag');
  });

  test('--config names a file explicitly and a bad value fails through the schema', async () => {
    const w = createTestWriter();
    await put(w, 'custom.yaml', 'bogus: 1\n');
    const r = await run(w, ['config', 'print', '--config', 'custom.yaml']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('bogus: unrecognized key');
  });

  test('convert honours the environment title below the flag', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(1)));
    await run(w, ['convert', 'in/a.json', '-o', 'out'], { OTEL_HTML_TITLE: 'env title' });
    expect(manifestOf(w, 'out').title).toBe('env title');
  });

  test('dashboards carry the config file name as their source, through config print and convert', async () => {
    const w = createTestWriter();
    const yaml =
      'dashboards:\n  - id: ops\n    title: Ops\n    widgets: [{type: traces, x: 0, y: 0, w: 6, h: 6}]\n';
    await put(w, '/work/custom.yaml', yaml);
    const printed = await run(w, ['config', 'print', '--config', '/work/custom.yaml']);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain('source: custom.yaml');
    await put(w, 'in/a.json', JSON.stringify(spansRequest(1)));
    const r = await run(w, ['convert', 'in/a.json', '-o', 'out', '--config', '/work/custom.yaml']);
    expect(r.code).toBe(0);
    expect(manifestOf(w, 'out').config.dashboards[0]?.source).toBe('custom.yaml');
  });
});
