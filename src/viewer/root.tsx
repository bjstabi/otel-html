import { type JSX, useCallback, useState } from 'react';
import { App } from './app.js';
import type { DataSource } from './data/data-source.js';
import type { HistoryPort } from './state/selection.js';
import { type ThemePreference, ThemeProvider } from './theme/theme-provider.js';

/** The viewer's composition: the report's `viewer.theme` becomes the theme default once its manifest has loaded. */
export function Root(props: { load: () => Promise<DataSource>; history: HistoryPort }): JSX.Element {
  const [theme, setTheme] = useState<ThemePreference>('system');
  const { load } = props;
  const loadAndApplyTheme = useCallback(async (): Promise<DataSource> => {
    const dataSource = await load();
    setTheme(dataSource.manifest.config.viewer.theme);
    return dataSource;
  }, [load]);
  return (
    <ThemeProvider defaultPreference={theme}>
      <App load={loadAndApplyTheme} history={props.history} />
    </ThemeProvider>
  );
}
