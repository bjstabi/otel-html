import { SeverityNumber } from '@opentelemetry/api';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { describe, expect, test } from 'vitest';
import { Report } from '../../src/api/report.js';
import { OtelHtmlLogRecordExporter } from '../../src/exporters/log-exporter.js';
import { createTestWriter } from '../../test-support/writer-deps.js';
import { allLogs, manifestOf } from '../writer/helpers.js';

function emitLogs(exporter: OtelHtmlLogRecordExporter, bodies: string[]): LoggerProvider {
  const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: exporter })] });
  const logger = provider.getLogger('t');
  for (const body of bodies) logger.emit({ severityNumber: SeverityNumber.INFO, body });
  return provider;
}

function oneRecord(): ReadableLogRecord {
  const memory = new InMemoryLogRecordExporter();
  new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: memory })] })
    .getLogger('t')
    .emit({ severityNumber: SeverityNumber.INFO, body: 'x' });
  const [record] = memory.getFinishedLogRecords();
  if (!record) throw new Error('no record');
  return record;
}

function exportOnce(exporter: OtelHtmlLogRecordExporter): Promise<{ code: number; error?: Error }> {
  return new Promise((resolve) => exporter.export([oneRecord()], resolve));
}

describe('OtelHtmlLogRecordExporter', () => {
  test('a logger provider delivers its records into the report', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const provider = emitLogs(new OtelHtmlLogRecordExporter({ report }), ['a', 'b']);
    await provider.shutdown();
    await report.close();
    expect(allLogs(w, 'r')).toHaveLength(2);
  });

  test('export after shutdown calls back a failure with an error', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const exporter = new OtelHtmlLogRecordExporter({ report });
    await exporter.shutdown();
    const result = await exportOnce(exporter);
    expect(result.code).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
    await report.close();
  });

  test('a report that rejects the records calls back a failure', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    await report.close();
    const result = await exportOnce(new OtelHtmlLogRecordExporter({ report }));
    expect(result.code).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
  });

  test('a successful export calls back code 0', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    expect((await exportOnce(new OtelHtmlLogRecordExporter({ report }))).code).toBe(0);
    await report.close();
  });

  test('forceFlush writes a checkpoint before the report is closed', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const exporter = new OtelHtmlLogRecordExporter({ report });
    await exportOnce(exporter);
    await exporter.forceFlush();
    expect(manifestOf(w, 'r').chunks.length).toBeGreaterThan(0);
    await report.close();
  });
});
