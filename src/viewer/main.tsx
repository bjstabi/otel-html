import { createRoot } from 'react-dom/client';
import { parseManifest } from '../format/manifest.js';
import { createDataSource } from './data/data-source.js';
import { installRegistry } from './data/registry.js';
import { createDomScriptLoader } from './data/script-loader.js';
import { createHashHistory } from './state/hash-history.js';
import { Root } from './root.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

const registry = installRegistry(window);
const loader = createDomScriptLoader(document, registry);
const history = createHashHistory(window);

// The manifest is validated at the boundary; its viewer config picks the eager or windowed strategy.
async function load(): ReturnType<typeof createDataSource> {
  const manifest = parseManifest(registry.takeStatic('manifest', 'data/manifest.js'));
  return createDataSource(loader, manifest, manifest.config.viewer.eagerBudgetBytes);
}

createRoot(root).render(<Root load={load} history={history} />);
