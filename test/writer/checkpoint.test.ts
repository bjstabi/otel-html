import { describe, expect, test } from 'vitest';
import { parseSessionState, type SessionState } from '../../src/format/state.js';
import type { TraceEntry } from '../../src/format/trace-shard.js';
import {
  jsObjectKeyOrder,
  stateSlotPieces,
  stringifyHead,
  writeStateSlot,
} from '../../src/writer/checkpoint.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

const entry = (name: string, chunks: number[]): TraceEntry => ({
  start: 1,
  end: 2,
  spans: 1,
  logs: 0,
  errors: 0,
  chunks: chunks.map((n) => `chunks/spans/${String(n).padStart(6, '0')}`),
  logChunks: [],
  root: { name, service: 'svc', resource: 'r' },
});

function stateOf(dedupe: string[], traceIndex: SessionState['traceIndex']): SessionState {
  return {
    formatVersion: 1,
    otelHtmlVersion: '1.2.3',
    epochUnixNano: '1700000000000000000',
    nextChunk: { spans: 3, logs: 0, metrics: 1 },
    rollups: { spans: { a: [1, 2, null] }, logs: {} },
    dedupe,
    traceIndex,
    metricStreams: { keys: ['k"< '], times: [], lasts: [], seriesKeys: [], seriesTimes: [], folded: [] },
    nextSegment: { '4': 2 },
  };
}

function pieces(state: SessionState): string[] {
  const { dedupe, traceIndex, ...head } = state;
  return [...stateSlotPieces(head, dedupe, Object.entries(traceIndex))];
}

const NASTY = 'quo"te </script>   \\ é';
const many = Array.from({ length: 2503 }, (_, i) => `t${i}${i % 7 === 0 ? NASTY : ''}`);

describe('stateSlotPieces', () => {
  test.each([
    [
      'several shards, long dedupe, escaping',
      many,
      { '5b': { [ID_A]: entry(NASTY, [0, 1]) }, '00': { [ID_B]: entry('x', []) } },
    ],
    ['short dedupe', ['one'], { '5b': { [ID_A]: entry('n', [2]) } }],
    ['empty dedupe', [], { '5b': { [ID_A]: entry('n', [2]) } }],
    ['empty index', ['one'], {}],
    ['empty everything', [], {}],
  ] as const)('joined pieces equal JSON.stringify of the full state: %s', (_n, dedupe, index) => {
    const state = stateOf([...dedupe], index as SessionState['traceIndex']);
    expect(pieces(state).join('')).toBe(JSON.stringify(state));
  });

  test('a head stringified up front gives the same bytes and no longer follows the live head', () => {
    const state = stateOf(['one'], { '5b': { [ID_A]: entry('n', [2]) } });
    const { dedupe, traceIndex, ...head } = state;
    const early = stringifyHead(head);
    head.nextSegment['4'] = 99; // the live structures go on changing after the prepare
    const bytes = [...stateSlotPieces(early, dedupe, Object.entries(traceIndex))].join('');
    expect(bytes).toBe(JSON.stringify({ ...state, nextSegment: { '4': 2 } }));
  });

  test('shards go out in object-key order, as JSON.stringify of an object keyed by them', () => {
    const names = ['00', '0a', '5b', '12', '99'];
    const index = Object.fromEntries(names.map((n) => [n, { [ID_A]: entry(n, []) }]));
    const state = stateOf(['x'], index);
    const { dedupe, traceIndex, ...head } = state;
    const sorted = Object.entries(traceIndex).sort(([a], [b]) => (a < b ? -1 : 1));
    const ordered = jsObjectKeyOrder(sorted.map(([n]) => n)).map(
      (n): [string, (typeof sorted)[number][1]] => [n, traceIndex[n] ?? {}],
    );
    const joined = [...stateSlotPieces(head, dedupe, ordered)].join('');
    expect(joined).toBe(JSON.stringify(state));
    expect(Object.keys(JSON.parse(joined).traceIndex)).toEqual(['12', '99', '00', '0a', '5b']);
  });

  test('a long dedupe list and several shards come in several pieces', () => {
    const state = stateOf(many, { '5b': { [ID_A]: entry('n', []) }, '5c': { [ID_A]: entry('n', []) } });
    expect(pieces(state).length).toBe(8);
  });
});

describe('writeStateSlot', () => {
  const state = stateOf(many, { '5b': { [ID_A]: entry(NASTY, [0]) }, '5c': { [ID_B]: entry('y', []) } });
  const { dedupe, traceIndex, ...head } = state;

  test('writes through writePiecesAtomic in more than one piece; the slot parses', async () => {
    const mem = createMemoryFileSystem();
    const calls: string[][] = [];
    const fs: FileSystem = {
      ...mem,
      async writePiecesAtomic(p, ps) {
        const list = [...ps];
        calls.push(list);
        await mem.writeTextAtomic(p, list.join(''));
      },
    };
    await mem.mkdirp('r/data/state');
    await writeStateSlot(fs, 'r', 0, head, dedupe, Object.entries(traceIndex));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.length).toBeGreaterThan(1);
    const text = mem.snapshot().get('r/data/state/session.0.json');
    expect(parseSessionState(JSON.parse(text ?? ''))).toEqual(state);
  });

  test('falls back to writeTextAtomic of the joined pieces', async () => {
    const mem = createMemoryFileSystem();
    const { writePiecesAtomic: _unused, ...rest } = mem;
    const fs: FileSystem = rest;
    await mem.mkdirp('r/data/state');
    await writeStateSlot(fs, 'r', 1, head, dedupe, Object.entries(traceIndex));
    expect(mem.snapshot().get('r/data/state/session.1.json')).toBe(JSON.stringify(state));
  });
});
