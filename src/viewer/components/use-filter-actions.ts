import { useState } from 'react';
import type { AnyValue } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import { useSelection } from '../state/selection-context.js';
import { addAttributeFilter } from './attribute-filter.js';
import type { FacetSignal } from './filter-tokens.js';
import type { AttributeActions } from './resource-tab.js';

/**
 * Filter / exclude actions that write into the explorer's condition for `signal`. A condition they cannot extend
 * sets `error` (cleared by the next attempt); the caller renders it.
 */
export function useFilterActions(signal: FacetSignal): {
  attribute: Pick<AttributeActions, 'onFilter' | 'onExclude'>;
  resource: Pick<AttributeActions, 'onFilter' | 'onExclude'>;
  error: string | null;
} {
  const sel = useSelection((s) => s);
  const [error, setError] = useState<string | null>(null);
  const filter =
    (scope: 'attribute' | 'resource', op: '==' | '!=') =>
    (key: string, value: AnyValue): void => {
      try {
        setError(null);
        sel.setCondition(addAttributeFilter(sel.condition, scope, key, value, op, signal));
      } catch (e) {
        setError(e instanceof OtelHtmlError ? e.message : String(e));
      }
    };
  return {
    attribute: { onFilter: filter('attribute', '=='), onExclude: filter('attribute', '!=') },
    resource: { onFilter: filter('resource', '=='), onExclude: filter('resource', '!=') },
    error,
  };
}
