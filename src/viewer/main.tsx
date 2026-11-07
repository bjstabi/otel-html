import { createRoot } from 'react-dom/client';
import type { DataSource } from './data/data-source.js';
import { type LoadProgress, openReport } from './data/open-report.js';
import { installRegistry } from './data/registry.js';
import { createDomScriptLoader } from './data/script-loader.js';
import { tracedLoader } from './data/traced.js';
import { Root } from './root.js';
import { createHashHistory } from './state/hash-history.js';
import { watchNavigation } from './telemetry.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

const registry = installRegistry(window);
const loader = tracedLoader(createDomScriptLoader(document, registry));
const history = createHashHistory(window);

/**
 * The manifest is validated at the boundary (a format 1 to 3 report is refused with the D12 message), then the
 * engine starts, the partitions register and the format-4 data source is built.
 */
function load(onProgress: (p: LoadProgress) => void): Promise<DataSource> {
  return openReport(
    registry.takeStatic('manifest', 'data/manifest.js'),
    {
      loader,
      baseUrl: document.baseURI,
      createWorker: (url) => new Worker(url),
      blobUrl: { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
      logger: console,
    },
    onProgress,
  );
}

watchNavigation(window);

createRoot(root).render(<Root load={load} history={history} />);
