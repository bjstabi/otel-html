import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { installRegistry } from './data/registry.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');
createRoot(root).render(<App registry={installRegistry(window)} />);
