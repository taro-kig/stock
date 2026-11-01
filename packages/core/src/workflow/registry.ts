import { z } from "zod";
import type { NodeContext } from "./context.ts";
import type { PortType, PortTypes } from "./ports.ts";

export interface PortDecl {
  type: PortType;
  optional?: boolean;
  description?: string;
}
export type PortDecls = Record<string, PortDecl>;

export type InputValues<I extends PortDecls> = {
  [K in keyof I]: I[K]["optional"] extends true ? PortTypes[I[K]["type"]] | undefined : PortTypes[I[K]["type"]];
};
export type OutputValues<O extends PortDecls> = { [K in keyof O]: PortTypes[O[K]["type"]] };

/**
 * none   - always runs (side effects: broker, approvals, DB writes that must happen)
 * inputs - pure function of (params, inputs): reused across runs and workflows
 * daily  - like inputs but also keyed by the run date (sources, DB reads)
 */
export type CachePolicy = "none" | "inputs" | "daily";

export const NODE_CATEGORIES = ["source", "filter", "llm", "data", "signal", "decision", "risk", "gate", "execution", "eval"] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export interface NodeDef<P extends z.ZodObject, I extends PortDecls, O extends PortDecls> {
  type: string;
  title: string;
  category: NodeCategory;
  description: string;
  /**
   * Bump whenever the node's behaviour changes (including logic it calls into):
   * cached outputs are keyed by it, so a stale version silently replays old results.
   */
  version: number;
  cache: CachePolicy;
  params: P;
  inputs: I;
  outputs: O;
  /** Safe default outputs used when `onError: fallback` (e.g. "no signal"). */
  fallback?(params: z.output<P>): OutputValues<O>;
  run(ctx: NodeContext, params: z.output<P>, inputs: InputValues<I>): Promise<OutputValues<O>>;
}

/** The type-erased form the engine works with. */
export type AnyNodeDef = NodeDef<z.ZodObject, PortDecls, PortDecls>;

/** Identity helper that preserves literal port types for checking node implementations. */
export function defineNode<const P extends z.ZodObject, const I extends PortDecls, const O extends PortDecls>(def: NodeDef<P, I, O>): NodeDef<P, I, O> {
  return def;
}

export interface NodeDescription {
  type: string;
  title: string;
  category: NodeCategory;
  description: string;
  version: number;
  cache: CachePolicy;
  hasFallback: boolean;
  inputs: Record<string, PortDecl>;
  outputs: Record<string, PortDecl>;
  paramsSchema: unknown;
}

export class NodeRegistry {
  readonly #defs = new Map<string, AnyNodeDef>();

  register(...defs: AnyNodeDef[]): this {
    for (const d of defs) {
      if (this.#defs.has(d.type)) throw new Error(`duplicate node type: ${d.type}`);
      this.#defs.set(d.type, d);
    }
    return this;
  }

  get(type: string): AnyNodeDef | undefined {
    return this.#defs.get(type);
  }

  list(): AnyNodeDef[] {
    return [...this.#defs.values()];
  }

  /** JSON description of every node type (for the node UI palette and docs). */
  describe(): NodeDescription[] {
    return this.list().map((d) => ({
      type: d.type, title: d.title, category: d.category, description: d.description, version: d.version,
      cache: d.cache, hasFallback: typeof d.fallback === "function", inputs: d.inputs, outputs: d.outputs,
      paramsSchema: z.toJSONSchema(d.params, { io: "input", unrepresentable: "any" }),
    }));
  }
}
