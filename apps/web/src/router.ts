import { useEffect, useState } from "react";

export const VIEWS = ["overview", "runs", "approvals", "scorecard", "workflows", "nodes", "settings", "prompts", "editor"] as const;
export type View = (typeof VIEWS)[number];
/** Views with a numbered tab (the editor is opened from a workflow). */
export const TABS = ["overview", "runs", "approvals", "scorecard", "workflows", "nodes", "settings", "prompts"] as const satisfies readonly View[];

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
