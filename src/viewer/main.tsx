import { createRoot } from 'react-dom/client';
import { parseManifest } from '../format/manifest.js';
import { createDataSource } from './data/data-source.js';
import { installRegistry } from './data/registry.js';
import { createDomScriptLoader } from './data/script-loader.js';
import { tracedDataSource, tracedLoader } from './data/traced.js';
import { Root } from './root.js';
import { createHashHistory } from './state/hash-history.js';
import { traced, watchNavigation } from './telemetry.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

const registry = installRegistry(window);
const loader = tracedLoader(createDomScriptLoader(document, registry));
const history = createHashHistory(window);

// The manifest is validated at the boundary; its viewer budget picks the eager or windowed strategy per signal.
async function load(): ReturnType<typeof createDataSource> {
  const manifest = parseManifest(registry.takeStatic('manifest', 'data/manifest.js'));
  return traced('viewer.load', { 'otel_html.report.version': manifest.otelHtmlVersion }, async (span) => {
    const ds = await createDataSource(loader, manifest, manifest.config.viewer.eagerBudgetBytes);
    span.setAttributes({
      'otel_html.format_version': manifest.formatVersion,
      'otel_html.spans.total': manifest.totals.spans,
      'otel_html.logs.total': manifest.totals.logs,
      'otel_html.metrics.total': manifest.totals.metrics,
      'otel_html.strategy.spans': ds.strategy,
      'otel_html.strategy.logs': ds.logStrategy,
    });
    return tracedDataSource(ds);
  });
}

watchNavigation(window);

createRoot(root).render(<Root load={load} history={history} />);
