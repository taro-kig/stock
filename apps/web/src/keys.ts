import { useEffect, useRef } from "react";

export type KeyMap = Record<string, (e: KeyboardEvent) => void>;

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

/** Global key bindings. Keys: "j", "Enter", "ArrowDown", "?"… Ignored while typing (except Escape). */
export function useKeys(map: KeyMap, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typing(e.target) && e.key !== "Escape") return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [enabled]);
}

/** j/k/↑/↓ movement over a list; returns the clamped next index. */
export function step(index: number, length: number, delta: number): number {
  if (length === 0) return -1;
  return Math.max(0, Math.min(length - 1, (index < 0 ? -1 : index) + delta));
}
