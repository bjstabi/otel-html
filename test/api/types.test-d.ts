import { expectTypeOf, test } from 'vitest';
import {
  type AddResult,
  type ConfigInput,
  convert,
  type ErrorCode,
  type Logger,
  type MetricExporterOptions,
  merge,
  type OtelHtmlError,
  type ReceiverOverrides,
  Report,
  type ReportDeps,
  type ReportSummary,
  type RunningReceiver,
  type SpanHandle,
  startReceiver,
  type Tracer,
} from '../../src/api/index.js';
import type { ViewerAssets } from '../../src/writer/viewer-assets.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

// Well-typed values of the old port types: only the excess-property error is left to expect.
const fs = createMemoryFileSystem();
const viewerAssets: ViewerAssets = {
  files: async () => [],
  entry: () => ({ script: 'assets/viewer.js', style: null }),
};

test('public API types', () => {
  expectTypeOf<MetricExporterOptions>().toHaveProperty('temporality');
  expectTypeOf(convert).returns.resolves.toEqualTypeOf<ReportSummary>();
  expectTypeOf(merge).returns.resolves.toEqualTypeOf<ReportSummary>();
  expectTypeOf<Parameters<typeof Report.create>[0]>().toHaveProperty('out').toEqualTypeOf<string>();
  expectTypeOf<ReportDeps>().toEqualTypeOf<{ logger: Logger; tracer: Tracer }>();
  expectTypeOf<Parameters<typeof Report.create>[1]>().toEqualTypeOf<Partial<ReportDeps> | undefined>();
  expectTypeOf<Parameters<typeof convert>[1]>().toEqualTypeOf<Partial<ReportDeps> | undefined>();
  expectTypeOf<Parameters<typeof merge>[1]>().toEqualTypeOf<Partial<ReportDeps> | undefined>();
  expectTypeOf<Parameters<typeof startReceiver>[2]>().toEqualTypeOf<Partial<ReportDeps> | undefined>();
  expectTypeOf<ReturnType<Tracer['startSpan']>>().toEqualTypeOf<SpanHandle>();
  expectTypeOf<ReturnType<Report['addLogs']>>().resolves.toEqualTypeOf<AddResult>();
  expectTypeOf<ReturnType<Report['close']>>().resolves.toEqualTypeOf<ReportSummary>();
  expectTypeOf<OtelHtmlError['code']>().toEqualTypeOf<ErrorCode>();
  expectTypeOf<NonNullable<Parameters<typeof Report.create>[0]['config']>>().toEqualTypeOf<
    ConfigInput | string
  >();

  expectTypeOf(startReceiver).returns.resolves.toEqualTypeOf<RunningReceiver>();
  expectTypeOf<false>().toExtend<ReceiverOverrides['http']>();
  expectTypeOf<RunningReceiver['http']>().toEqualTypeOf<string | null>();

  const never = (): void => {
    // @ts-expect-error unknown option is a type error
    void convert({ input: 'a.json', out: 'r', outdir: 'x' });
    // @ts-expect-error out is required
    void merge({ inputs: ['a'] });
    // @ts-expect-error a version is not a public dep
    void Report.create({ out: 'r' }, { version: 'x' });
    // @ts-expect-error the file system is not a public dep
    void convert({ input: 'a.json', out: 'r' }, { version: 'x', fs });
    // @ts-expect-error neither is the viewer build
    void merge({ inputs: ['a'], out: 'r' }, { viewerAssets });
  };
  void never;
});
