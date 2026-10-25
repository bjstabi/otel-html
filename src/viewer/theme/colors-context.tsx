import { createContext, type JSX, type ReactNode, useContext, useMemo } from 'react';
import { type ColorAssigner, createColorAssigner } from './palette.js';

const ColorsContext = createContext<ColorAssigner | null>(null);

/** One assigner for the whole shell, so a service has the same colour on every page. */
export function ColorsProvider({ children }: { children: ReactNode }): JSX.Element {
  const assigner = useMemo(() => createColorAssigner(), []);
  return <ColorsContext.Provider value={assigner}>{children}</ColorsContext.Provider>;
}

/** The shared assigner, or a private one when rendered outside a provider (isolated component tests). */
export function useColorAssigner(): ColorAssigner {
  const shared = useContext(ColorsContext);
  const local = useMemo(() => createColorAssigner(), []);
  return shared ?? local;
}
