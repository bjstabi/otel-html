import { describe, expect, test } from 'vitest';
import type { SpanId } from '../../src/model/ids.js';
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
const none = { logSpanIds: null, logsError: null };
const ids = (
  s: SpanRecord,
  ctx: { logSpanIds: ReadonlySet<SpanId> | null; logsError: string | null } = none,
): string[] => availableSpanTabs(s, ctx).map((t) => t.id);

describe('SPAN_TABS', () => {
  test('lists overview, events, logs, links, resource in order', () => {
    expect(SPAN_TABS.map((t) => t.id)).toEqual(['overview', 'events', 'logs', 'links', 'resource']);
    expect([...SPAN_TAB_IDS].sort()).toEqual(SPAN_TABS.map((t) => t.id).sort());
  });

  test('links and events are omitted when empty', () => {
    expect(ids(base)).toEqual(['overview', 'resource']);
  });

  test('links shows with links, events shows with events', () => {
    expect(ids({ ...base, links: [link] })).toEqual(['overview', 'links', 'resource']);
    expect(ids({ ...base, events: [event] })).toEqual(['overview', 'events', 'resource']);
  });

  test('logs shows only when the span emitted a log; null (still loading) hides it', () => {
    const withLog = { logSpanIds: new Set([base.spanId]), logsError: null };
    expect(ids(base, withLog)).toEqual(['overview', 'logs', 'resource']);
    expect(ids(base, { logSpanIds: new Set<SpanId>(), logsError: null })).toEqual(['overview', 'resource']);
    expect(ids(base, none)).toEqual(['overview', 'resource']);
  });

  test('logs stays visible when the log load failed, so the error has a place to show', () => {
    expect(ids(base, { logSpanIds: null, logsError: 'boom' })).toEqual(['overview', 'logs', 'resource']);
  });

  test('isSpanTabId accepts known ids only', () => {
    expect(isSpanTabId('links')).toBe(true);
    expect(isSpanTabId('logs')).toBe(true);
    expect(isSpanTabId('bogus')).toBe(false);
    expect(isSpanTabId('flame')).toBe(false);
  });
});
