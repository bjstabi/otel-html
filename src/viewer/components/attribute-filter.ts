import { type AnyValue, anyValueToDisplay } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import { type FilterToken, facetKeyToPath, ottlToTokens, tokensToOttl } from './filter-tokens.js';

/** The token literal for a scalar attribute value; null for values a filter cannot express (array, kvlist, bytes, empty). */
export function tokenValue(v: AnyValue): FilterToken['value'] | undefined {
  switch (v.kind) {
    case 'string':
    case 'bool':
      return v.value;
    case 'int': {
      const n = Number(v.value);
      return Number.isSafeInteger(n) ? n : v.value.toString();
    }
    case 'double':
      return Number.isFinite(v.value) ? v.value : anyValueToDisplay(v);
    case 'array':
    case 'kvlist':
    case 'bytes':
    case 'empty':
      return undefined;
  }
}

/**
 * `condition` with `<scope>.attributes["key"] <op> value` added. An identical key/value token (either operator) is
 * replaced, so a value is never both included and excluded. Throws when the existing condition is not a flat
 * `and` of filter tokens (the query bar shows such a condition as raw OTTL).
 */
export function addAttributeFilter(
  condition: string | null,
  scope: 'attribute' | 'resource',
  key: string,
  value: AnyValue,
  op: '==' | '!=',
): string | null {
  const literal = tokenValue(value);
  if (literal === undefined) return condition;
  let tokens: FilterToken[] = [];
  if (condition !== null) {
    const parsed = ottlToTokens(condition);
    if (parsed === null) {
      throw new OtelHtmlError('invalid-ottl', {
        path: 'condition',
        expected: 'a flat `and` of filter tokens to add a filter',
        actual: JSON.stringify(condition),
      });
    }
    tokens = parsed;
  }
  const path = facetKeyToPath(key, 'span', scope);
  const rest = tokens.filter(
    (t) => !(t.key === path && t.value === literal && (t.op === '==' || t.op === '!=')),
  );
  rest.push({ key: path, op, value: literal });
  return tokensToOttl(rest);
}
