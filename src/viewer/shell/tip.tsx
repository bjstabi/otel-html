import { Tooltip } from '@base-ui/react/tooltip';
import type { JSX, ReactElement } from 'react';

/** A hover and focus hint for an icon-only control; the control keeps its own accessible name. */
export function Tip(props: { label: string; children: ReactElement }): JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={props.children} />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="rounded-md bg-ink px-2 py-1 text-xs text-page">
            {props.label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
