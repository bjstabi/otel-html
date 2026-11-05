import { useEffect, useState } from 'react';

/** Re-resolves colour tokens when the theme attributes on the root element change. */
export function useThemeTick(): number {
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => mo.disconnect();
  }, []);
  return themeTick;
}
