import { expectTypeOf, test } from 'vitest';
import {
  type AddResult,
  type ConfigInput,
  convert,
  type ErrorCode,
  merge,
  type OtelHtmlError,
  type ReceiverOverrides,
  type Report,
  type ReportSummary,
  type RunningReceiver,
  startReceiver,
  type WriterDeps,
} from '../../src/api/index.js';

test('public API types', () => {
  expectTypeOf(convert).returns.resolves.toEqualTypeOf<ReportSummary>();
  expectTypeOf(merge).returns.resolves.toEqualTypeOf<ReportSummary>();
  expectTypeOf<Parameters<typeof Report.create>[0]>().toHaveProperty('out').toEqualTypeOf<string>();
  expectTypeOf<Parameters<typeof Report.create>[1]>().toEqualTypeOf<Partial<WriterDeps> | undefined>();
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
  };
  void never;
});
