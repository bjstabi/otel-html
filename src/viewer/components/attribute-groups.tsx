import { Ban, Copy, ListFilter, Pin, PinOff } from 'lucide-react';
import { type JSX, useMemo, useState } from 'react';
import { type AnyValue, type Attributes, anyValueToDisplay, anyValueToJson } from '../../model/anyvalue.js';
import { groupAttributes } from '../../semconv/groups.js';
import { tokenValue } from './attribute-filter.js';
import { JsonTree } from './json-tree.js';

export const PINS_STORAGE_KEY = 'oh:pinned-attributes';

/** Pinned attribute keys from localStorage; empty when storage is unavailable or holds something else. */
export function loadPins(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(PINS_STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function savePins(pins: readonly string[]): void {
  try {
    window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Storage is optional: pins then last for this page view only.
  }
}

export interface AttributeGroupsProps {
  attributes: Attributes;
  /** Keys shown first, in this order, when present. */
  pinned: readonly string[];
  /** Add an `==` token for the value. Omit to hide the action. */
  onFilter?: (key: string, value: AnyValue) => void;
  /** Add a `!=` token for the value. Omit to hide the action. */
  onExclude?: (key: string, value: AnyValue) => void;
  /** Toggle the pin of a key. Omit to hide the action. */
  onTogglePin?: (key: string) => void;
}

interface TreeNode {
  label: string;
  key: string | null;
  value: AnyValue | null;
  children: TreeNode[];
}

/** Nest dotted keys by segment, merging a valueless node with its only child (`a` + `b` -> `a.b`). */
export function buildTree(entries: readonly (readonly [string, AnyValue])[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const [key, value] of entries) {
    let level = roots;
    let node: TreeNode | undefined;
    for (const segment of key.split('.')) {
      node = level.find((n) => n.label === segment);
      if (node === undefined) {
        node = { label: segment, key: null, value: null, children: [] };
        level.push(node);
      }
      level = node.children;
    }
    if (node !== undefined) {
      node.key = key;
      node.value = value;
    }
  }
  return roots.map(compact);
}

function compact(n: TreeNode): TreeNode {
  let node = n;
  while (node.value === null && node.children.length === 1) {
    const only = node.children[0];
    if (only === undefined) break;
    node = { ...only, label: `${node.label}.${only.label}` };
  }
  return { ...node, children: node.children.map(compact) };
}

const ACTION =
  'inline-flex items-center justify-center rounded-full p-1 text-ink-2 hover:bg-hairline focus-visible:outline-2';

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}...` : s;
}

function CopyButton(props: { name: string; text: string }): JSX.Element {
  const [done, setDone] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (clipboard === undefined) throw new Error('clipboard unavailable');
      await clipboard.writeText(props.text);
      setDone(true);
    } catch {
      setDone(false);
    }
  };
  return (
    <button
      type="button"
      aria-label={`Copy value of ${props.name}`}
      title={done ? 'Copied' : 'Copy value'}
      className={ACTION}
      onClick={() => void copy()}
    >
      <Copy size={13} aria-hidden />
    </button>
  );
}

function ValueView(props: { name: string; value: AnyValue }): JSX.Element {
  const { value } = props;
  if (value.kind === 'array' || value.kind === 'kvlist') {
    return <JsonTree data={anyValueToJson(value)} label={`Value of ${props.name}`} />;
  }
  if (value.kind === 'empty') return <span className="text-xs text-muted">(empty)</span>;
  // `bdi` isolates bidi overrides so a hostile value cannot reorder the text around it.
  return (
    <bdi className="block max-h-40 min-w-0 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
      {anyValueToDisplay(value)}
    </bdi>
  );
}

function Row(props: { node: TreeNode } & Omit<AttributeGroupsProps, 'attributes'>): JSX.Element {
  const { node, pinned, onFilter, onExclude, onTogglePin } = props;
  const key = node.key;
  const value = node.value;
  const filterable = value !== null && tokenValue(value) !== undefined;
  const isPinned = key !== null && pinned.includes(key);
  const shown = value === null ? '' : clip(anyValueToDisplay(value));
  return (
    <li>
      {key !== null && value !== null ? (
        <div data-key={key} className="flex flex-wrap items-start gap-x-3 gap-y-1 py-1">
          <span title={key} className="min-w-32 shrink-0 font-mono text-xs text-ink-2">
            {node.label}
          </span>
          <div className="min-w-0 flex-1">
            <ValueView name={key} value={value} />
          </div>
          <span className="inline-flex shrink-0 items-center">
            {onFilter !== undefined && filterable && (
              <button
                type="button"
                aria-label={`Filter ${key} to ${shown}`}
                title="Filter to this value"
                className={ACTION}
                onClick={() => onFilter(key, value)}
              >
                <ListFilter size={13} aria-hidden />
              </button>
            )}
            {onExclude !== undefined && filterable && (
              <button
                type="button"
                aria-label={`Exclude ${key} ${shown}`}
                title="Exclude this value"
                className={ACTION}
                onClick={() => onExclude(key, value)}
              >
                <Ban size={13} aria-hidden />
              </button>
            )}
            <CopyButton name={key} text={anyValueToDisplay(value)} />
            {onTogglePin !== undefined && (
              <button
                type="button"
                aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${key}`}
                aria-pressed={isPinned}
                title={isPinned ? 'Unpin' : 'Pin to the top'}
                className={ACTION}
                onClick={() => onTogglePin(key)}
              >
                {isPinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
              </button>
            )}
          </span>
        </div>
      ) : (
        <div className="py-1 font-mono text-xs text-muted">{node.label}</div>
      )}
      {node.children.length > 0 && (
        <ul className="ml-3 border-l border-hairline pl-3">
          {node.children.map((c) => (
            <Row key={c.label} node={c} pinned={pinned} {...handlers(props)} />
          ))}
        </ul>
      )}
    </li>
  );
}

function handlers(
  p: Omit<AttributeGroupsProps, 'attributes' | 'pinned'>,
): Omit<AttributeGroupsProps, 'attributes' | 'pinned'> {
  return {
    ...(p.onFilter === undefined ? {} : { onFilter: p.onFilter }),
    ...(p.onExclude === undefined ? {} : { onExclude: p.onExclude }),
    ...(p.onTogglePin === undefined ? {} : { onTogglePin: p.onTogglePin }),
  };
}

function Group(props: {
  label: string;
  entries: readonly (readonly [string, AnyValue])[];
  rest: Omit<AttributeGroupsProps, 'attributes'>;
}): JSX.Element {
  const tree = useMemo(() => buildTree(props.entries), [props.entries]);
  return (
    <fieldset aria-label={props.label} className="mb-3 min-w-0 border-0 p-0">
      <h4 className="mb-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">{props.label}</h4>
      <ul>
        {tree.map((n) => (
          <Row key={n.label} node={n} {...props.rest} />
        ))}
      </ul>
    </fieldset>
  );
}

/**
 * Attributes as a pinned group followed by semconv groups (`SEMCONV_GROUPS` order, Other last). Dotted keys nest
 * and kvlist/array values expand as trees. Every value is a React text node.
 */
export function AttributeGroups(props: AttributeGroupsProps): JSX.Element {
  const { attributes, pinned } = props;
  const pinnedEntries = useMemo(
    () =>
      pinned.flatMap((k): [string, AnyValue][] => {
        const v = attributes.get(k);
        return v === undefined ? [] : [[k, v]];
      }),
    [attributes, pinned],
  );
  const groups = useMemo(() => {
    const pinnedKeys = new Set(pinnedEntries.map(([k]) => k));
    const rest = new Map([...attributes].filter(([k]) => !pinnedKeys.has(k)));
    return groupAttributes(rest);
  }, [attributes, pinnedEntries]);
  const rest = { pinned, ...handlers(props) };
  if (pinnedEntries.length === 0 && groups.length === 0) {
    return <p className="text-sm text-muted">No attributes.</p>;
  }
  return (
    <div>
      {pinnedEntries.length > 0 && <Group label="Pinned" entries={pinnedEntries} rest={rest} />}
      {groups.map((g) => (
        <Group key={g.label} label={g.label} entries={g.entries} rest={rest} />
      ))}
    </div>
  );
}
