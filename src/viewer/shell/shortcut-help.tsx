import { Dialog } from '@base-ui/react/dialog';
import type { JSX } from 'react';
import { SHORTCUTS } from './shortcuts.js';

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-ink/30" />
        <Dialog.Popup className="fixed left-1/2 top-1/4 w-96 max-w-[90vw] -translate-x-1/2 rounded-card border border-hairline bg-surface p-4 shadow-lg">
          <Dialog.Title className="text-base font-semibold">Keyboard shortcuts</Dialog.Title>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            {SHORTCUTS.map((s) => (
              <div key={s.action} className="contents">
                <dt>
                  <kbd className="rounded border border-hairline bg-page px-1.5 py-0.5 font-mono text-xs">
                    {s.keys.join(' ')}
                  </kbd>
                </dt>
                <dd className="text-ink-2">{s.label}</dd>
              </div>
            ))}
          </dl>
          <Dialog.Close className="mt-4 rounded-full border border-hairline px-3 py-1.5 text-sm hover:bg-hairline">
            Close
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
