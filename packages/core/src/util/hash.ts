import { createHash } from "node:crypto";

/** JSON with object keys sorted, so equal values always hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export function sha256(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p, "utf8");
    h.update("\u0000");
  }
  return h.digest("hex");
}
