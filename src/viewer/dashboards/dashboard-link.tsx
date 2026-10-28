import type { JSX, ReactNode } from 'react';
import { useGoTo } from '../shell/go-to.js';
import { routeHref } from '../shell/use-route.js';

/** A link to the list or a dashboard; it drops the previous dashboard's `d` state. */
export function DashboardLink(props: { to: string; className?: string; children: ReactNode }): JSX.Element {
  const goTo = useGoTo();
  const route = props.to;
  return (
    <a
      href={routeHref(route)}
      {...(props.className === undefined ? {} : { className: props.className })}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goTo('dashboards', route, { d: null });
      }}
    >
      {props.children}
    </a>
  );
}
