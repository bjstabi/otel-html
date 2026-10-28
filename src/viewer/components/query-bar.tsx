import { Plus, Search, X } from 'lucide-react';
import { type JSX, useEffect, useRef, useState } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import { compileCondition } from '../../ottl/compile.js';
import type { OttlContextName } from '../../ottl/contexts.js';
import { useSelection } from '../state/selection-context.js';
import { type FacetSignal, type FilterToken, ottlToTokens, tokensToOttl } from './filter-tokens.js';

const OPS: readonly FilterToken['op'][] = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'matches',
  'exists',
  'not exists',
];
const NUMERIC_OPS: ReadonlySet<FilterToken['op']> = new Set(['>', '>=', '<', '<=']);
const NO_VALUE_OPS: ReadonlySet<FilterToken['op']> = new Set(['exists', 'not exists']);
const FIELD = 'rounded-md border border-hairline bg-surface px-2 py-1 font-mono text-xs';

function isOp(v: string): v is FilterToken['op'] {
  return OPS.some((o) => o === v);
}

/** `col N: expected …, got …` for OTTL errors (the column is the 1-based offset into the source). */
export function describeOttlError(e: unknown): string {
  if (e instanceof OtelHtmlError) {
    const detail =
      e.expected !== undefined && e.actual !== undefined
        ? `expected ${e.expected}, got ${e.actual}`
        : e.message;
    return e.path === undefined ? detail : `${e.path}: ${detail}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Coerces edited text into a token value; numeric operators need a finite number. */
function coerceValue(
  op: FilterToken['op'],
  previous: FilterToken['value'],
  text: string,
): FilterToken['value'] {
  if (NO_VALUE_OPS.has(op)) return null;
  if (NUMERIC_OPS.has(op) || typeof previous === 'number') {
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) return n;
    if (NUMERIC_OPS.has(op))
      throw new OtelHtmlError('usage', {
        path: 'filter value',
        expected: `a number for ${op}`,
        actual: JSON.stringify(text),
      });
  }
  return text;
}

const ENUM_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The edited chip as a token. An enum chip (`>= SEVERITY_NUMBER_WARN`) keeps an edited enum name as an enum and
 * turns an edited number into a plain number; anything else is coerced like any other value.
 */
function editedToken(next: FilterToken, previous: FilterToken): FilterToken {
  const text = String(next.value ?? '').trim();
  const base = { key: next.key, op: next.op };
  if (previous.enum === true && !NO_VALUE_OPS.has(next.op)) {
    const n = Number(text);
    if (text !== '' && Number.isFinite(n)) return { ...base, value: n };
    if (ENUM_NAME.test(text)) return { ...base, value: text, enum: true };
  }
  return { ...base, value: coerceValue(next.op, previous.value, String(next.value ?? '')) };
}

/** Schedules `fn` after `ms`; returns a cancel function. Injectable so tests need no real timers. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

const timeoutScheduler: Scheduler = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export const TEXT_DEBOUNCE_MS = 250;

function TokenChip(props: {
  token: FilterToken;
  /** Returns true when the change was accepted (the store was written). Values arrive as the typed text. */
  onChange(next: FilterToken): boolean;
  onRemove(): void;
}): JSX.Element {
  const { token } = props;
  // The value is committed on Enter or blur, so a half-typed number never reaches the store.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft !== null && props.onChange({ ...token, value: draft })) setDraft(null);
  };
  return (
    <li className="flex items-center gap-1 rounded-full border border-hairline bg-surface py-0.5 pr-1 pl-2">
      <span className="font-mono text-xs">{token.key}</span>
      <select
        aria-label={`Operator of ${token.key}`}
        value={token.op}
        onChange={(e) => {
          const op = e.target.value;
          if (isOp(op)) props.onChange({ ...token, op, value: String(token.value ?? '') });
        }}
        className={FIELD}
      >
        {OPS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {NO_VALUE_OPS.has(token.op) ? null : (
        <input
          type="text"
          aria-label={`Value of ${token.key}`}
          value={draft ?? String(token.value ?? '')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          className={`${FIELD} w-28`}
        />
      )}
      <button
        type="button"
        aria-label={`Remove ${token.key}`}
        onClick={props.onRemove}
        className="rounded-full p-1 text-muted hover:bg-hairline"
      >
        <X size={12} aria-hidden />
      </button>
    </li>
  );
}

function AddFilter(props: {
  keyPlaceholder: string;
  labelSuffix: string;
  onAdd(key: string, op: FilterToken['op'], value: string): boolean;
}): JSX.Element {
  const sfx = props.labelSuffix;
  const [key, setKey] = useState('');
  const [op, setOp] = useState<FilterToken['op']>('==');
  const [value, setValue] = useState('');
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        // On failure the parent shows the error and the typed input stays.
        if (props.onAdd(key.trim(), op, value)) {
          setKey('');
          setValue('');
        }
      }}
    >
      <input
        type="text"
        aria-label={`New filter key${sfx}`}
        placeholder={props.keyPlaceholder}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className={`${FIELD} w-44`}
      />
      <select
        aria-label={`New filter operator${sfx}`}
        value={op}
        onChange={(e) => {
          if (isOp(e.target.value)) setOp(e.target.value);
        }}
        className={FIELD}
      >
        {OPS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <input
        type="text"
        aria-label={`New filter value${sfx}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={NO_VALUE_OPS.has(op)}
        className={`${FIELD} w-28`}
      />
      <button
        type="submit"
        aria-label={`Add filter${sfx}`}
        disabled={key.trim() === ''}
        className="rounded-full border border-hairline bg-surface p-1 hover:bg-hairline disabled:opacity-50"
      >
        <Plus size={14} aria-hidden />
      </button>
    </form>
  );
}

/**
 * OTTL filter tokens over one condition, or a raw OTTL editor when `rawOpen` (or when the condition is not a flat
 * `and` of tokens). Nothing reaches `onChange` that does not compile in `context`; edits commit on Enter or blur.
 * The page query bar and each Metrics query row's `where` use it.
 */
export function ConditionEditor(props: {
  condition: string | null;
  onChange(condition: string | null): void;
  context: OttlContextName;
  rawOpen: boolean;
  keyPlaceholder: string;
  /** Appended to the controls' accessible names when a page holds several editors (` of a`). */
  labelSuffix?: string;
}): JSX.Element {
  const { condition, onChange, context, rawOpen } = props;
  const sfx = props.labelSuffix ?? '';
  const tokens = condition === null ? [] : ottlToTokens(condition);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const raw = tokens === null || rawOpen;

  // An external condition change (facet click, back/forward, clear) or switching editors discards a stale raw
  // draft and its error.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `condition` and `rawOpen` are triggers, not values read
  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [condition, rawOpen]);

  /** Applies `fn`; an OtelHtmlError becomes the inline message, anything else is a bug and propagates. */
  const guarded = (fn: () => void): boolean => {
    try {
      fn();
      setError(null);
      return true;
    } catch (e) {
      if (e instanceof OtelHtmlError) {
        setError(describeOttlError(e));
        return false;
      }
      throw e;
    }
  };

  const commitTokens = (next: readonly FilterToken[], compile = true): void => {
    const src = tokensToOttl(next);
    // Compile first so an invalid regex or a path from another signal never reaches the store. A removal skips
    // it: it adds nothing, and must work on a condition that already does not compile.
    if (compile && src !== null) compileCondition(src, context);
    onChange(src);
  };
  const current = tokens ?? [];

  const checkRaw = (src: string): string | null => {
    if (src.trim() === '') return null;
    try {
      compileCondition(src, context);
      return null;
    } catch (e) {
      if (e instanceof OtelHtmlError) return describeOttlError(e);
      throw e;
    }
  };

  const editRaw = (src: string): void => {
    setDraft(src);
    setError(checkRaw(src)); // live feedback; the store is written on commit only
  };
  const commitRaw = (): void => {
    if (draft === null) return;
    const problem = checkRaw(draft);
    setError(problem);
    if (problem === null) onChange(draft.trim() === '' ? null : draft);
  };

  return (
    <>
      {raw ? (
        <div className="flex flex-col gap-1">
          {tokens === null ? (
            <p className="text-xs text-muted">
              This condition can't be shown as tokens; edit the OTTL directly or clear it.
            </p>
          ) : null}
          <textarea
            aria-label={`OTTL condition${sfx}`}
            aria-invalid={error !== null}
            spellCheck={false}
            rows={2}
            value={draft ?? condition ?? ''}
            onChange={(e) => editRaw(e.target.value)}
            onBlur={commitRaw}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitRaw();
              }
            }}
            className={`${FIELD} w-full`}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ul aria-label={`Filters${sfx}`} className="flex flex-wrap gap-2">
            {current.map((t, i) => (
              <TokenChip
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity; the same key may repeat
                key={`${t.key}:${i}`}
                token={t}
                onChange={(next) =>
                  guarded(() => commitTokens(current.map((x, j) => (j === i ? editedToken(next, x) : x))))
                }
                onRemove={() =>
                  guarded(() =>
                    commitTokens(
                      current.filter((_, j) => j !== i),
                      false,
                    ),
                  )
                }
              />
            ))}
          </ul>
          <AddFilter
            keyPlaceholder={props.keyPlaceholder}
            labelSuffix={sfx}
            onAdd={(key, op, value) =>
              guarded(() => commitTokens([...current, { key, op, value: coerceValue(op, null, value) }]))
            }
          />
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="font-mono text-xs text-critical">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Free-text search, OTTL filter tokens, and a raw OTTL editor. Invalid input never reaches the store, and typing
 * does not write per keystroke: free text is debounced, tokens and raw OTTL commit on Enter or blur.
 */
export function QueryBar(props: {
  signal: FacetSignal;
  debounceMs?: number;
  schedule?: Scheduler;
}): JSX.Element {
  const condition = useSelection((s) => s.condition);
  const text = useSelection((s) => s.text);
  const setText = useSelection((s) => s.setText);
  const setCondition = useSelection((s) => s.setCondition);
  const tokens = condition === null ? [] : ottlToTokens(condition);
  const [rawOpen, setRawOpen] = useState(false);
  const raw = tokens === null || rawOpen;

  // Free text: local value, one store write once typing pauses (or on Enter/blur).
  const schedule = props.schedule ?? timeoutScheduler;
  const debounceMs = props.debounceMs ?? TEXT_DEBOUNCE_MS;
  const [localText, setLocalText] = useState(text);
  const cancelPending = useRef<(() => void) | null>(null);
  const latestText = useRef(text);
  const localTextRef = useRef(localText);
  localTextRef.current = localText;
  useEffect(() => {
    // An external change (URL navigation, clear) wins over a stale local value.
    cancelPending.current?.();
    cancelPending.current = null;
    latestText.current = text;
    setLocalText(text);
  }, [text]);
  useEffect(
    () => () => {
      cancelPending.current?.();
    },
    [],
  );
  const flushText = (): void => {
    cancelPending.current?.();
    cancelPending.current = null;
    if (latestText.current !== localTextRef.current) setText(localTextRef.current);
  };

  return (
    <div className="flex min-w-48 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-48 flex-1 items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1.5">
          <Search size={16} aria-hidden className="text-muted" />
          <input
            type="search"
            data-oh-query
            aria-label="Search"
            placeholder="Search (press / to focus)"
            value={localText}
            onChange={(e) => {
              const v = e.target.value;
              setLocalText(v);
              localTextRef.current = v;
              cancelPending.current?.();
              cancelPending.current = schedule(() => {
                cancelPending.current = null;
                setText(v);
              }, debounceMs);
            }}
            onBlur={flushText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') flushText();
            }}
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <button
          type="button"
          aria-pressed={raw}
          disabled={tokens === null}
          onClick={() => setRawOpen(!rawOpen)}
          className="rounded-full border border-hairline px-3 py-1.5 text-sm aria-pressed:bg-ink aria-pressed:text-page"
        >
          OTTL
        </button>
        <span className="group relative">
          <button
            type="button"
            aria-disabled="true"
            aria-describedby="oh-add-query-hint"
            onClick={(e) => e.preventDefault()}
            className="rounded-full border border-hairline px-3 py-1.5 text-sm text-muted opacity-60"
          >
            + Query
          </button>
          <span
            id="oh-add-query-hint"
            role="tooltip"
            className="absolute top-full left-0 z-10 mt-1 hidden whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs text-page group-focus-within:block group-hover:block"
          >
            second query arrives with Dashboards
          </span>
        </span>
        {condition === null ? null : (
          <button
            type="button"
            onClick={() => setCondition(null)}
            className="rounded-full px-3 py-1.5 text-sm text-muted hover:bg-hairline"
          >
            Clear filters
          </button>
        )}
      </div>
      <ConditionEditor
        condition={condition}
        onChange={setCondition}
        context={props.signal === 'log' ? 'log_record' : 'span'}
        rawOpen={rawOpen}
        keyPlaceholder={props.signal === 'log' ? 'log.attributes["key"]' : 'span.attributes["key"]'}
      />
    </div>
  );
}
