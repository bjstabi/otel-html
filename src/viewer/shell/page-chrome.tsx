import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Download, Link2 } from 'lucide-react';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import type { ExplorerPage } from '../../query/pages.js';
import type { FacetSignal } from '../components/filter-tokens.js';
import { QueryBar } from '../components/query-bar.js';
import { TimeRange } from './time-range.js';
import { ViewsMenu } from './views-menu.js';

export interface ExportItem {
  label: string;
  onSelect(): void;
  /** Why the item is unavailable; the item is then disabled and shows this as its description. */
  disabled?: string;
}

export const CONTROL =
  'flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1.5 text-sm text-ink hover:bg-hairline';
export const POPUP = 'rounded-card border border-hairline bg-surface p-1 shadow-lg';

/** The clipboard fallback: the text in a read-only, pre-selected box (a link, a YAML document) to copy by hand. */
export function CopyTextDialog(props: {
  title: string;
  /** Accessible name of the text box. */
  label: string;
  text: string;
  onClose: () => void;
}): JSX.Element {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.select();
  }, []);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-ink/30" />
        <Dialog.Popup
          className={`${POPUP} fixed left-1/2 top-1/3 w-[32rem] max-w-[90vw] -translate-x-1/2 p-4`}
        >
          <Dialog.Title className="text-base font-semibold">{props.title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Clipboard access is unavailable here. Select and copy the text below.
          </Dialog.Description>
          <textarea
            ref={box}
            readOnly
            value={props.text}
            aria-label={props.label}
            rows={Math.min(14, props.text.split('\n').length + 1)}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-3 w-full rounded-md border border-hairline bg-page px-2 py-1.5 font-mono text-xs"
          />
          <Dialog.Close className={`${CONTROL} mt-3`}>Close</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Copies text to the clipboard. Without a clipboard (or when it refuses) `dialog` is the `CopyTextDialog` to render
 * so the text can be copied by hand; otherwise it is null.
 */
export function useClipboardCopy(dialogText: { title: string; label: string }): {
  copy: (text: string) => Promise<boolean>;
  dialog: JSX.Element | null;
} {
  const [fallback, setFallback] = useState<string | null>(null);
  const copy = async (text: string): Promise<boolean> => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      setFallback(text);
      return false;
    }
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      setFallback(text);
      return false;
    }
  };
  const dialog =
    fallback === null ? null : (
      <CopyTextDialog
        title={dialogText.title}
        label={dialogText.label}
        text={fallback}
        onClose={() => setFallback(null)}
      />
    );
  return { copy, dialog };
}

/** A button that copies `text()` and says "Copied"; without a clipboard (or when it refuses) it opens `CopyTextDialog`. */
export function CopyButton(props: {
  label: string;
  icon: ReactNode;
  text: () => string;
  /** The dialog's title and text-box name. */
  dialog: { title: string; label: string };
  className?: string;
}): JSX.Element {
  const { copy, dialog } = useClipboardCopy(props.dialog);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <>
      <button
        type="button"
        className={props.className ?? CONTROL}
        onClick={() => void copy(props.text()).then((ok) => setCopied(ok))}
      >
        {props.icon}
        <span>{props.label}</span>
        <span role="status" className={copied ? 'text-xs text-accent' : 'sr-only'}>
          {copied ? 'Copied' : ''}
        </span>
      </button>
      {dialog}
    </>
  );
}

export function CopyLink(props: { className?: string }): JSX.Element {
  return (
    <CopyButton
      label="Copy link"
      icon={<Link2 size={16} aria-hidden />}
      text={() => window.location.href}
      dialog={{ title: 'Copy link', label: 'Link' }}
      {...(props.className === undefined ? {} : { className: props.className })}
    />
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
                  disabled={i.disabled !== undefined}
                  className="rounded-md px-3 py-1.5 text-sm hover:bg-hairline data-[disabled]:text-muted data-[disabled]:hover:bg-transparent"
                >
                  {i.label}
                  {i.disabled === undefined ? null : (
                    <span className="block max-w-64 text-xs text-muted">{i.disabled}</span>
                  )}
                </Menu.Item>
              ))
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Title, page actions, query bar, time range, Copy link and the Export menu; `exportItems` is filled per page. */
export function PageChrome(props: {
  title: string;
  /** Which OTTL context the query bar compiles in; spans or log records. Without one there is no query bar (Metrics filters per query). */
  signal?: FacetSignal;
  manifest: Manifest;
  /** An explorer page: shows its Views menu. */
  page?: ExplorerPage;
  exportItems?: readonly ExportItem[];
  /** Extra header controls (a page's own buttons), between the title and Copy link. */
  actions?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-hairline p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-xl font-semibold">{props.title}</h1>
          {props.page === undefined ? null : <ViewsMenu page={props.page} manifest={props.manifest} />}
          {props.actions}
          <CopyLink />
          <ExportMenu items={props.exportItems ?? []} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {props.signal === undefined ? null : <QueryBar signal={props.signal} />}
          <TimeRange manifest={props.manifest} />
        </div>
      </header>
      <main className="flex-1 p-4">{props.children}</main>
    </div>
  );
}
