import { describe, expect, test } from 'vitest';
import {
  EMPTY_DASHBOARD_STATE,
  isPristine,
  parseDashboardParam,
} from '../../src/viewer/state/dashboard-state.js';
import { createSelectionStore, selectionToUrlState } from '../../src/viewer/state/selection.js';
import { parseUrlState, serializeUrlState } from '../../src/viewer/state/url-state.js';

const TRACE = 'a'.repeat(32);
const d = (v: unknown): string => `d=${encodeURIComponent(JSON.stringify(v))}`;

describe('parseDashboardParam', () => {
  test('fills every field with its default', () => {
    expect(parseDashboardParam('{}')).toEqual({ ok: true, state: EMPTY_DASHBOARD_STATE });
  });

  test('parses a full state', () => {
    const state = {
      vars: { 'service.name': 'checkout', 'host.name': null },
      sel: { t: '1~2', trace: TRACE },
      follow: { w1: false },
      logView: { w2: 'context' },
    };
    expect(parseDashboardParam(JSON.stringify(state))).toEqual({ ok: true, state });
  });

  test.each([
    ['an unknown top-level key', { nope: 1 }, 'd.nope: expected a known key, got 1'],
    [
      'a reversed window',
      { sel: { t: '9~1' } },
      /^d\.sel\.t: expected <start>~<end> with start <= end.*, got "9~1"$/,
    ],
    [
      'an all-zero trace id',
      { sel: { trace: '0'.repeat(32) } },
      /^d\.sel\.trace: expected a non-zero trace id, got /,
    ],
    [
      'a bad log view',
      { logView: { w1: 'x' } },
      /^d\.logView\.w1: expected one of matches, context, got "x"$/,
    ],
  ])('%s gives one error line naming its path', (_name, value, expected) => {
    const r = parseDashboardParam(JSON.stringify(value));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    if (typeof expected === 'string') expect(r.error).toBe(expected);
    else expect(r.error).toMatch(expected);
  });

  test('text that is not JSON is reported', () => {
    expect(parseDashboardParam('{')).toEqual({ ok: false, error: 'd: expected a JSON object, got "{"' });
  });
});

describe('the d URL key', () => {
  test('a bad d is reported and the rest of the URL survives', () => {
    const r = parseUrlState(`t=1~2&${d({ sel: { t: '9~1' } })}`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^d\.sel\.t: expected /);
    expect(r.state).toEqual({ t: '1~2' });
  });

  test('round-trips through the store', () => {
    const state = { ...EMPTY_DASHBOARD_STATE, sel: { t: '1~2', trace: null }, vars: { a: null } };
    const { state: parsed, errors } = parseUrlState(serializeUrlState({ d: state }));
    expect(errors).toEqual([]);
    const store = createSelectionStore(parsed);
    expect(store.getState().dashboard).toEqual(state);
    expect(selectionToUrlState(store.getState())).toEqual({ d: state });
  });

  test('a pristine state serializes to the empty string', () => {
    expect(isPristine(EMPTY_DASHBOARD_STATE)).toBe(true);
    const store = createSelectionStore({});
    store.getState().setDashboard(EMPTY_DASHBOARD_STATE);
    expect(serializeUrlState(selectionToUrlState(store.getState()))).toBe('');
    store.getState().setDashboard({ ...EMPTY_DASHBOARD_STATE, follow: { w1: true } });
    expect(isPristine(store.getState().dashboard ?? EMPTY_DASHBOARD_STATE)).toBe(false);
    expect(serializeUrlState(selectionToUrlState(store.getState()))).not.toBe('');
  });
});
