import { type JSX, useCallback, useState } from 'react';
import { App } from './app.js';
import type { LoadProgress, OpenedReport } from './data/open-report.js';
import type { HistoryPort } from './state/selection.js';
import { type ThemePreference, ThemeProvider } from './theme/theme-provider.js';

/** The viewer's composition: the report's `viewer.theme` becomes the theme default once its manifest has loaded. */
export function Root(props: {
  load: (onProgress: (p: LoadProgress) => void) => Promise<OpenedReport>;
  history: HistoryPort;
}): JSX.Element {
  const [theme, setTheme] = useState<ThemePreference>('system');
  const { load } = props;
  const loadAndApplyTheme = useCallback(
    async (onProgress: (p: LoadProgress) => void): Promise<OpenedReport> => {
      const opened = await load(onProgress);
      setTheme(opened.dataSource.manifest.config.viewer.theme);
      return opened;
    },
    [load],
  );
  return (
    <ThemeProvider defaultPreference={theme}>
      <App load={loadAndApplyTheme} history={props.history} />
    </ThemeProvider>
  );
}
