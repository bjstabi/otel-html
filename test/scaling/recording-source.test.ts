import { describe, expect, test } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import {
  entryIdsOf,
  type RecordedCall,
  recordingDataSource,
} from '../../test-support/scaling/recording-source.js';

const manifest = { statisticsKeys: { spans: [], logs: [] } } as unknown as ManifestV4;
const inner = {
  querySpans: async (): Promise<null> => null,
  serviceShare: async (): Promise<null> => null,
} as unknown as DataSource;

/** A page that asks `serviceShare` only `delayMs` after its rows returned, as the trace list does once its rows render. */
function openPage(delayMs: number): ReturnType<typeof recordingDataSource> {
  const recording = recordingDataSource(inner, manifest);
  void recording.ds.querySpans({} as Parameters<DataSource['querySpans']>[0]).then(() => {
    setTimeout(
      () => void recording.ds.serviceShare('t' as Parameters<DataSource['serviceShare']>[0]),
      delayMs,
    );
  });
  return recording;
}

describe('settled', () => {
  test('waits for every method the page must ask, past a render longer than the quiet period', async () => {
    const { calls, settled } = openPage(400);
    await settled(['querySpans', 'serviceShare']);
    expect(calls.map((c) => c.method)).toEqual(['querySpans', 'serviceShare']);
  });

  test('fails naming the methods a page never asked', async () => {
    const { settled } = openPage(10_000);
    await expect(settled(['serviceShare'], 300)).rejects.toThrow(/serviceShare/);
  });
});

const resourceValuesCall = (window: RecordedCall['window']): RecordedCall => ({
  method: 'resourceValues',
  needs: [],
  window,
  condition: 'none',
  mode: null,
  attrFacets: false,
  residual: false,
  failedWhen: false,
  idKey: null,
  summary: false,
});

test('a resourceValues call with no window maps to the entry of the report range', () => {
  expect(entryIdsOf(resourceValuesCall('none'), true)).toEqual(['resourceValues.all']);
  expect(entryIdsOf(resourceValuesCall('none'), false)).toEqual(['resourceValues.all.short']);
  expect(entryIdsOf(resourceValuesCall('window'), false)).toEqual(['resourceValues.short']);
});
