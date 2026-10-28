import { describe, expect, test } from 'vitest';
import type { LogRow } from '../../src/viewer/data/log-query.js';
import { availableLogTabs, LOG_TAB_IDS, LOG_TABS } from '../../src/viewer/logs/tabs.js';
import { availableTabs, isTraceTabId, TRACE_TAB_IDS, TRACE_TABS } from '../../src/viewer/traces/tabs.js';
import { detailOf, traceRow } from './trace-rows.js';

const none = { hasMetrics: false };

describe('TRACE_TABS', () => {
  test('lists the tabs in order, logs and metrics before errors', () => {
    expect(TRACE_TABS.map((t) => t.id)).toEqual([
      'flame',
      'waterfall',
      'spans',
      'services',
      'logs',
      'metrics',
      'errors',
    ]);
    expect([...TRACE_TAB_IDS].sort()).toEqual(TRACE_TABS.map((t) => t.id).sort());
  });

  test('logs shows only when the trace has logs', () => {
    const d = detailOf([traceRow(1, null, 0, 10)]);
    expect(availableTabs(d, none).map((t) => t.id)).not.toContain('logs');
    expect(availableTabs({ ...d, logCount: 3 }, none).map((t) => t.id)).toEqual([
      'flame',
      'waterfall',
      'spans',
      'services',
      'logs',
    ]);
  });

  test('errors is hidden for an error-free trace', () => {
    const d = detailOf([traceRow(1, null, 0, 10), traceRow(2, 1, 1, 2)]);
    expect(availableTabs(d, none).map((t) => t.id)).toEqual(['flame', 'waterfall', 'spans', 'services']);
  });

  test('errors shows for an error status or for an exception event', () => {
    expect(
      availableTabs(detailOf([traceRow(1, null, 0, 10, { error: true })]), none).map((t) => t.id),
    ).toContain('errors');
    expect(
      availableTabs(detailOf([traceRow(1, null, 0, 10, { exception: true })]), none).map((t) => t.id),
    ).toContain('errors');
  });

  test('metrics shows only when the trace resources have metrics', () => {
    const d = detailOf([traceRow(1, null, 0, 10)]);
    expect(availableTabs(d, { hasMetrics: true }).map((t) => t.id)).toEqual([
      'flame',
      'waterfall',
      'spans',
      'services',
      'metrics',
    ]);
  });

  test('isTraceTabId accepts known ids only', () => {
    expect(isTraceTabId('metrics')).toBe(true);
    expect(isTraceTabId('waterfall')).toBe(true);
    expect(isTraceTabId('logs')).toBe(true);
    expect(isTraceTabId('bogus')).toBe(false);
    expect(isTraceTabId('overview')).toBe(false);
  });
});

describe('LOG_TABS', () => {
  const row = {} as LogRow;
  test('lists attributes, trace, metrics, surrounding, resource in order', () => {
    expect(LOG_TABS.map((t) => t.id)).toEqual(['attributes', 'trace', 'metrics', 'surrounding', 'resource']);
    expect([...LOG_TAB_IDS]).toEqual(LOG_TABS.map((t) => t.id));
  });

  test('metrics shows only when the log resource has metrics', () => {
    const ids = (hasMetrics: boolean): string[] =>
      availableLogTabs(row, { hasTrace: false, hasMetrics }).map((t) => t.id);
    expect(ids(false)).toEqual(['attributes', 'surrounding', 'resource']);
    expect(ids(true)).toEqual(['attributes', 'metrics', 'surrounding', 'resource']);
  });
});
