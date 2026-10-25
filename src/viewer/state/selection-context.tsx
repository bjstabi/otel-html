import { createContext, type JSX, type ReactNode, useContext } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { OtelHtmlError } from '../../model/errors.js';
import type { Selection } from './selection.js';

const SelectionContext = createContext<StoreApi<Selection> | null>(null);

export function SelectionProvider(props: { store: StoreApi<Selection>; children: ReactNode }): JSX.Element {
  return <SelectionContext.Provider value={props.store}>{props.children}</SelectionContext.Provider>;
}

export function useSelection<T>(selector: (s: Selection) => T): T {
  const store = useContext(SelectionContext);
  if (store === null)
    throw new OtelHtmlError('usage', {
      path: 'useSelection',
      expected: 'a <SelectionProvider> ancestor',
      actual: 'no provider',
    });
  return useStore(store, selector);
}
