import { useEffect, useState } from "react";

export const VIEWS = ["overview", "runs", "approvals", "scorecard", "workflows", "nodes", "settings", "prompts", "calendar", "watchlist", "editor"] as const;
export type View = (typeof VIEWS)[number];
/**
 * Views with a numbered tab, ordered by how often they are used (daily first).
 * Not tabs: the editor and the node catalog live under フロー, settings behind ⚙ (key ",").
 */
export const TABS = ["overview", "approvals", "runs", "scorecard", "calendar", "watchlist", "workflows", "prompts"] as const satisfies readonly View[];

/** The number key of a tab ("2" for approvals …), for hints in the UI. */
export const tabKey = (v: (typeof TABS)[number]): string => String(TABS.indexOf(v) + 1);

/** The tab a view belongs to (for highlighting). */
export function tabOf(v: View): View {
  return v === "editor" || v === "nodes" ? "workflows" : v;
}

export interface Route {
  view: View;
  param: string | null;
}

function parse(): Route {
  const [, v, ...rest] = location.hash.replace(/^#/, "").split("/");
  const view = (VIEWS as readonly string[]).includes(v ?? "") ? (v as View) : "overview";
  return { view, param: rest.length ? decodeURIComponent(rest.join("/")) : null };
}

export function navigate(view: View, param?: string | null): void {
  const next = `#/${view}${param ? `/${encodeURIComponent(param)}` : ""}`;
  if (location.hash !== next) location.hash = next;
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}
