import { type JSX, useEffect, useState } from 'react';
import type { Manifest } from '../format/manifest.js';
import type { Registry } from './data/registry.js';

export function App({ registry }: { registry: Registry }): JSX.Element {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    registry.take('manifest').then(
      (m) => setManifest(m as Manifest),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [registry]);

  if (error !== null) return <p role="alert">{error}</p>;
  if (manifest === null) return <p>Loading</p>;
  return <h1 className="text-xl font-semibold">{manifest.title}</h1>;
}
