import { describe, expect, test } from 'vitest';
import type { SpanLinkRecord, SpanRecord } from '../../src/model/records.js';
import { availableSpanTabs, isSpanTabId, SPAN_TAB_IDS, SPAN_TABS } from '../../src/viewer/traces/tabs.js';
import { traceRow } from './trace-rows.js';

const base = traceRow(1, null, 0, 10).span;
const link: SpanLinkRecord = {
  traceId: base.traceId,
  spanId: base.spanId,
  traceState: '',
  attributes: new Map(),
  droppedAttributesCount: 0,
  flags: 0,
};
const event = { time: base.start, name: 'e', attributes: new Map(), droppedAttributesCount: 0 };
const ids = (s: SpanRecord): string[] => availableSpanTabs(s).map((t) => t.id);

describe('SPAN_TABS', () => {
  test('lists overview, events, links, resource, logs in order; logs is never available until M2 builds it', () => {
    expect(SPAN_TABS.map((t) => t.id)).toEqual(['overview', 'events', 'links', 'resource', 'logs']);
    expect(SPAN_TAB_IDS).toEqual(SPAN_TABS.map((t) => t.id));
  });

  test('links and events are omitted when empty', () => {
    expect(ids(base)).toEqual(['overview', 'resource']);
  });

  test('links shows with links, events shows with events', () => {
    expect(ids({ ...base, links: [link] })).toEqual(['overview', 'links', 'resource']);
    expect(ids({ ...base, events: [event] })).toEqual(['overview', 'events', 'resource']);
  });

  test('isSpanTabId accepts known ids only', () => {
    expect(isSpanTabId('links')).toBe(true);
    expect(isSpanTabId('logs')).toBe(true);
    expect(isSpanTabId('bogus')).toBe(false);
    expect(isSpanTabId('flame')).toBe(false);
  });
});
