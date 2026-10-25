import { Plus, Search, X } from 'lucide-react';
import { type JSX, useState } from 'react';
import { OtelHtmlError } from '../../model/errors.js';
import { compileCondition } from '../../ottl/compile.js';
import { useSelection } from '../state/selection-context.js';
import { type FilterToken, ottlToTokens, tokensToOttl } from './filter-tokens.js';

const OPS: readonly FilterToken['op'][] = [
  '==',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
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

function TokenChip(props: {
  token: FilterToken;
  /** `raw` token values are text from the input; the parent coerces them (and reports bad numbers). */
  onChange(next: FilterToken): void;
  onRemove(): void;
}): JSX.Element {
  const { token } = props;
  // A numeric token being retyped keeps the raw text so "1." or "" do not snap back mid-edit.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <li className="flex items-center gap-1 rounded-full border border-hairline bg-surface py-0.5 pr-1 pl-2">
      <span className="font-mono text-xs">{token.key}</span>
      <select
        aria-label={`Operator of ${token.key}`}
        value={token.op}
        onChange={(e) => {
          const op = e.target.value;
          if (isOp(op))
            props.onChange({ ...token, op, value: coerceValue(op, token.value, String(token.value ?? '')) });
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
          onChange={(e) => {
            setDraft(e.target.value);
            props.onChange({ ...token, value: e.target.value });
          }}
          onBlur={() => setDraft(null)}
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

function AddFilter(props: { onAdd(t: FilterToken): void }): JSX.Element {
  const [key, setKey] = useState('');
  const [op, setOp] = useState<FilterToken['op']>('==');
  const [value, setValue] = useState('');
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        props.onAdd({ key: key.trim(), op, value: coerceValue(op, null, value) });
        setKey('');
        setValue('');
      }}
    >
      <input
        type="text"
        aria-label="New filter key"
        placeholder='span.attributes["key"]'
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className={`${FIELD} w-44`}
      />
      <select
        aria-label="New filter operator"
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
        aria-label="New filter value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={NO_VALUE_OPS.has(op)}
        className={`${FIELD} w-28`}
      />
      <button
        type="submit"
        aria-label="Add filter"
        disabled={key.trim() === ''}
        className="rounded-full border border-hairline bg-surface p-1 hover:bg-hairline disabled:opacity-50"
      >
        <Plus size={14} aria-hidden />
      </button>
    </form>
  );
}

/** Free-text search, OTTL filter tokens, and a raw OTTL editor. Invalid input never reaches the store. */
export function QueryBar(props: { signal: 'span' }): JSX.Element {
  const condition = useSelection((s) => s.condition);
  const text = useSelection((s) => s.text);
  const setText = useSelection((s) => s.setText);
  const setCondition = useSelection((s) => s.setCondition);
  const tokens = condition === null ? [] : ottlToTokens(condition);
  const [rawOpen, setRawOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const raw = tokens === null || rawOpen;

  const commitTokens = (next: readonly FilterToken[]): void => {
    try {
      setCondition(tokensToOttl(next));
      setError(null);
    } catch (e) {
      setError(describeOttlError(e));
    }
  };

  const editRaw = (src: string): void => {
    setDraft(src);
    if (src.trim() === '') {
      setError(null);
      setCondition(null);
      return;
    }
    try {
      compileCondition(src, props.signal);
    } catch (e) {
      setError(describeOttlError(e));
      return;
    }
    setError(null);
    setCondition(src);
  };

  const guarded = (fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      setError(describeOttlError(e));
    }
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
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <button
          type="button"
          aria-pressed={raw}
          disabled={tokens === null}
          onClick={() => {
            setRawOpen(!rawOpen);
            setDraft(null);
            setError(null);
          }}
          className="rounded-full border border-hairline px-3 py-1.5 text-sm aria-pressed:bg-ink aria-pressed:text-page"
        >
          OTTL
        </button>
        <span title="second query arrives with Dashboards">
          <button
            type="button"
            disabled
            className="rounded-full border border-hairline px-3 py-1.5 text-sm text-muted opacity-60"
          >
            + Query
          </button>
        </span>
        {condition === null ? null : (
          <button
            type="button"
            onClick={() => {
              setCondition(null);
              setDraft(null);
              setError(null);
            }}
            className="rounded-full px-3 py-1.5 text-sm text-muted hover:bg-hairline"
          >
            Clear filters
          </button>
        )}
      </div>
      {raw ? (
        <div className="flex flex-col gap-1">
          {tokens === null ? (
            <p className="text-xs text-muted">
              This condition can't be shown as tokens; edit the OTTL directly or clear it.
            </p>
          ) : null}
          <textarea
            aria-label="OTTL condition"
            aria-invalid={error !== null}
            spellCheck={false}
            rows={2}
            value={draft ?? condition ?? ''}
            onChange={(e) => editRaw(e.target.value)}
            className={`${FIELD} w-full`}
          />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ul className="flex flex-wrap gap-2">
            {(tokens ?? []).map((t, i) => (
              <TokenChip
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity; the same key may repeat
                key={`${t.key}:${i}`}
                token={t}
                onChange={(next) =>
                  guarded(() =>
                    commitTokens(
                      (tokens ?? []).map((x, j) =>
                        j === i
                          ? { ...next, value: coerceValue(next.op, x.value, String(next.value ?? '')) }
                          : x,
                      ),
                    ),
                  )
                }
                onRemove={() => commitTokens((tokens ?? []).filter((_, j) => j !== i))}
              />
            ))}
          </ul>
          <AddFilter onAdd={(t) => guarded(() => commitTokens([...(tokens ?? []), t]))} />
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="font-mono text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
