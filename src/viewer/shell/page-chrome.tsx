import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Download, Link2, Search } from 'lucide-react';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { useSelection } from '../state/selection-context.js';
import { TimeRange } from './time-range.js';

export interface ExportItem {
  label: string;
  onSelect(): void;
}

const CONTROL =
  'flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1.5 text-sm text-ink hover:bg-hairline';
const POPUP = 'rounded-card border border-hairline bg-surface p-1 shadow-lg';

function FallbackDialog({ url, onClose }: { url: string; onClose: () => void }): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-ink/30" />
        <Dialog.Popup
          className={`${POPUP} fixed left-1/2 top-1/3 w-[32rem] max-w-[90vw] -translate-x-1/2 p-4`}
        >
          <Dialog.Title className="text-base font-semibold">Copy link</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Clipboard access is unavailable here. Select and copy the link below.
          </Dialog.Description>
          <input
            ref={input}
            readOnly
            value={url}
            aria-label="Link"
            onFocus={(e) => e.currentTarget.select()}
            className="mt-3 w-full rounded-md border border-hairline bg-page px-2 py-1.5 font-mono text-xs"
          />
          <Dialog.Close className={`${CONTROL} mt-3`}>Close</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CopyLink(): JSX.Element {
  const [fallback, setFallback] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    const url = window.location.href;
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      setFallback(url);
      return;
    }
    try {
      await clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFallback(url);
    }
  };
  return (
    <>
      <button type="button" className={CONTROL} onClick={() => void copy()}>
        <Link2 size={16} aria-hidden />
        <span>Copy link</span>
        <span role="status" className="sr-only">
          {copied ? 'Link copied' : ''}
        </span>
      </button>
      {fallback !== null && <FallbackDialog url={fallback} onClose={() => setFallback(null)} />}
    </>
  );
}

function ExportMenu({ items }: { items: readonly ExportItem[] }): JSX.Element {
  return (
    <Menu.Root>
      <Menu.Trigger className={CONTROL}>
        <Download size={16} aria-hidden />
        Export
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className={POPUP}>
            {items.length === 0 ? (
              <Menu.Item disabled className="px-3 py-1.5 text-sm text-muted">
                Nothing to export on this page
              </Menu.Item>
            ) : (
              items.map((i) => (
                <Menu.Item
                  key={i.label}
                  onClick={i.onSelect}
                  className="rounded-md px-3 py-1.5 text-sm hover:bg-hairline"
                >
                  {i.label}
                </Menu.Item>
              ))
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function QueryBar(): JSX.Element {
  const text = useSelection((s) => s.text);
  const setText = useSelection((s) => s.setText);
  return (
    <label className="flex min-w-48 flex-1 items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1.5">
      <Search size={16} aria-hidden className="text-muted" />
      <input
        type="search"
        data-oh-query
        aria-label="Search"
        placeholder="Search (press / to focus)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full bg-transparent text-sm outline-none"
      />
    </label>
  );
}

/** Title, query bar, time range, Copy link and the Export menu; `exportItems` is filled per page. */
export function PageChrome(props: {
  title: string;
  manifest: Manifest;
  exportItems?: readonly ExportItem[];
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-hairline p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-xl font-semibold">{props.title}</h1>
          <CopyLink />
          <ExportMenu items={props.exportItems ?? []} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <QueryBar />
          <TimeRange manifest={props.manifest} />
        </div>
      </header>
      <main className="flex-1 p-4">{props.children}</main>
    </div>
  );
}
