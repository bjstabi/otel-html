import { createContext, type JSX, type ReactNode, useContext, useMemo } from 'react';
import { type ColorAssigner, createColorAssigner } from './palette.js';

const ColorsContext = createContext<ColorAssigner | null>(null);
const RunLineColorsContext = createContext<ColorAssigner | null>(null);

/** One assigner for the whole shell, so a service has the same colour on every page. */
export function ColorsProvider({ children }: { children: ReactNode }): JSX.Element {
  const assigner = useMemo(() => createColorAssigner(), []);
  const runLines = useMemo(() => createColorAssigner(), []);
  return (
    <ColorsContext.Provider value={assigner}>
      <RunLineColorsContext.Provider value={runLines}>{children}</RunLineColorsContext.Provider>
    </ColorsContext.Provider>
  );
}

/** The shared assigner, or a private one when rendered outside a provider (isolated component tests). */
export function useColorAssigner(): ColorAssigner {
  const shared = useContext(ColorsContext);
  const local = useMemo(() => createColorAssigner(), []);
  return shared ?? local;
}

/**
 * The assigner for run chart lines, apart from the shared one: other widgets' services and facet values would use up
 * its seven colours first and leave every line gray. A job has the same colour on every run chart.
 */
export function useRunLineColorAssigner(): ColorAssigner {
  const shared = useContext(RunLineColorsContext);
  const local = useMemo(() => createColorAssigner(), []);
  return shared ?? local;
}
