import { z } from "zod";
import { LLMError, type LLMProvider } from "../llm/types.ts";
import { sha256 } from "../util/hash.ts";
import type { CostTracker } from "./budget.ts";
import type { LLMCache } from "./cache.ts";

export interface CallResult<T> {
  provider: string;
  value: T | null;
  attempts: number;
  cached: boolean;
  error?: string;
}

const FENCE = /^```(?:json)?\s*|\s*```$/gm;

export function extractJson(text: string): unknown {
  const t = text.trim().replace(FENCE, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in output");
  return JSON.parse(t.slice(start, end + 1));
}

const instructionCache = new WeakMap<z.ZodType, string>();

export function schemaInstruction(schema: z.ZodType): string {
  let s = instructionCache.get(schema);
  if (!s) {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    s =
      "\n\n# 出力形式\n次の JSON Schema に厳密に従う JSON オブジェクトを1つだけ出力すること。" +
      "説明文やコードブロックは不要。\n" +
      JSON.stringify(json);
    instructionCache.set(schema, s);
  }
  return s;
}

function formatIssues(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return String(e);
}

export interface CallArgs {
  /** Stable name of the schema; part of the cache key. */
  schemaName: string;
  system: string;
  user: string;
  /** Bump when prompt wording changes, so cached results stay attributable. */
  promptVersion: string;
}

/** H1 (+H4, H5): cache -> budget -> call -> parse -> validate -> retry with the error as feedback. */
export class StructuredCaller {
  readonly cache: LLMCache | undefined;
  readonly budget: CostTracker | undefined;
  readonly maxRetries: number;
  readonly temperature: number;

  constructor(opts: { cache?: LLMCache; budget?: CostTracker; maxRetries?: number; temperature?: number } = {}) {
    this.cache = opts.cache;
    this.budget = opts.budget;
    this.maxRetries = opts.maxRetries ?? 2;
    this.temperature = opts.temperature ?? 0;
  }

  /** BudgetExceeded is thrown on purpose: the caller must stop the LLM stage (fail-safe). */
  async call<S extends z.ZodType>(provider: LLMProvider, schema: S, args: CallArgs): Promise<CallResult<z.output<S>>> {
    const system = args.system + schemaInstruction(schema);
    const key = sha256(provider.model, args.promptVersion, args.schemaName, system, args.user);

    const hit = this.cache?.get(key);
    if (hit !== undefined) {
      const parsed = schema.safeParse(hit);
      if (parsed.success) return { provider: provider.name, value: parsed.data, attempts: 0, cached: true };
      // schema changed since caching -> recompute
    }

    let prompt = args.user;
    let lastErr = "";
    const maxAttempts = this.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.budget?.check();
      let text: string;
      try {
        const resp = await provider.generate({ system, user: prompt, temperature: this.temperature, jsonMode: true });
        this.budget?.record(provider.name, resp);
        text = resp.text;
      } catch (e) {
        if (e instanceof LLMError) return { provider: provider.name, value: null, attempts: attempt, cached: false, error: `llm: ${e.message}` };
        throw e;
      }
      try {
        const value = schema.parse(extractJson(text));
        this.cache?.put(key, value);
        return { provider: provider.name, value, attempts: attempt, cached: false };
      } catch (e) {
        lastErr = formatIssues(e).slice(0, 800);
        prompt = `${args.user}\n\n# 注意\n前回の出力は次の理由で不正だった。スキーマに従った JSON のみを出力し直すこと。\n${lastErr}`;
      }
    }
    return { provider: provider.name, value: null, attempts: maxAttempts, cached: false, error: `invalid output: ${lastErr}` };
  }
}
