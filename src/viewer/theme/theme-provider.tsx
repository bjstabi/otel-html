import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'otel-html:theme';

function isPreference(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** The viewer's own saved choice, or null when it never made one (the report's default then applies). */
function readStored(): ThemePreference | null {
  try {
    const v: unknown = window.localStorage.getItem(STORAGE_KEY);
    return isPreference(v) ? v : null;
  } catch {
    return null;
  }
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(next: ThemePreference): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * `defaultPreference` is the report's `viewer.theme` setting. It applies until the viewer picks a theme themselves
 * (the saved choice wins), and follows the prop once it arrives with the manifest.
 */
export function ThemeProvider(props: {
  children: ReactNode;
  defaultPreference?: ThemePreference;
}): JSX.Element {
  const { children, defaultPreference = 'system' } = props;
  const [chosen, setChosen] = useState<ThemePreference | null>(readStored);
  const preference = chosen ?? defaultPreference;
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = (): void => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = preference === 'system' ? system : preference;

  // Layout effect: the attribute must flip before any child's passive effect reads CSS variables.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference): void => {
    setChosen(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable (file:// privacy modes); the choice just does not persist
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
