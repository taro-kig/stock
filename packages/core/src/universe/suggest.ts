import { z } from "zod";
import { SecClient } from "../data/sec.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { Services } from "../services.ts";
import { jpListings, verifyJp, type JpListing } from "./jp.ts";

/**
 * "Find me stocks for this theme": an LLM proposes US tickers, and every proposal is
 * checked against the SEC's current list of listed companies before a person can add it.
 * LLMs misremember tickers, mix up companies and do not know recent delistings, so an
 * unverified suggestion is never added silently.
 */
export const SECTORS = [
  "tech", "semis", "communication", "consumer", "staples", "healthcare", "financials",
  "energy", "industrials", "materials", "utilities", "real_estate",
] as const;

export const SIZES = ["any", "large", "mid", "small"] as const;
export type SizePreference = (typeof SIZES)[number];

export const SuggestRequest = z.strictObject({
  theme: z.string().trim().min(2).max(200),
  count: z.number().int().min(3).max(25).default(10),
  size: z.enum(SIZES).default("any"),
  /** us: NYSE / Nasdaq, checked with the SEC list · jp: TSE, checked with the J-Quants listing. */
  market: z.enum(["us", "jp"]).default("us"),
});
export type SuggestRequest = z.input<typeof SuggestRequest>;

const Suggestion = z.object({
  candidates: z
    .array(z.object({
      ticker: z.string().describe("米国の取引所のティッカー（例 AVGO, BRK.B）"),
      name: z.string().describe("ニュースで使われる通称（例 Broadcom, Palo Alto Networks）"),
      aliases: z.array(z.string()).max(4).default([]).describe("ニュースで使われる別の呼び方（任意）"),
      sector: z.enum(SECTORS),
      reason: z.string().max(200).describe("テーマとの関係を日本語で1文"),
    }))
    .max(40),
});

export const SUGGEST_PROMPT_VERSION = "universe-v1";
/** Built-in prompts for ticker suggestions (user versions live in prompts/universe/). */
export const UNIVERSE_PROMPTS: Record<string, { system: string }> = {};

export const UNIVERSE_V1_SYSTEM = `あなたは米国株に詳しいアナリストの補助として、テーマに合う銘柄の候補を挙げる。売買の推奨ではなく、観察対象（ウォッチリスト）の候補選び。
規則:
- NYSE または Nasdaq に上場している、米国の事業会社の普通株だけ（ETF・投資信託・ADR・SPAC・OTC 銘柄は除く）。
- ティッカーは正確に。自信がない会社は挙げない。合併・上場廃止・社名変更があった会社は最新の状態で。
- 1日の売買代金が十分ある（流動性が高い）銘柄を優先。
- 同じ会社の複数クラス（GOOGL と GOOG など）は1つだけ。
- 「除外」に挙がっているティッカーは出さない。
- name はニュースの見出しで使われる通称（"Inc." などは付けない）。reason は日本語で、テーマとの関係を具体的に1文。
- 規模の希望: large = 時価総額 $10B 以上 / mid = $2B〜$10B / small = $300M〜$2B / any = 指定なし。`;
UNIVERSE_PROMPTS["universe-v1"] = { system: UNIVERSE_V1_SYSTEM };

export const UNIVERSE_JP_V1_SYSTEM = `あなたは日本株に詳しいアナリストの補助として、テーマに合う銘柄の候補を挙げる。売買の推奨ではなく、観察対象（ウォッチリスト）の候補選び。
規則:
- 東京証券取引所のプライム・スタンダード・グロース市場に上場している日本の事業会社の普通株だけ（ETF・REIT・インフラファンド・TOKYO PRO Market は除く）。
- ticker は 4 文字の証券コード（例 7203、6758、130A）。自信がない会社は挙げない。合併・上場廃止・社名変更・持株会社化があった会社は最新の状態で。
- 1日の売買代金が十分ある（流動性が高い）銘柄を優先。
- 「除外」に挙がっているコードは出さない。
- name はニュースの見出しで使われる通称（「株式会社」は付けない。例 トヨタ、ソニーグループ）。aliases には英語名や略称（例 Toyota, Sony）。reason は日本語で、テーマとの関係を具体的に1文。
- sector は最も近いものを選ぶ。
- 規模の希望: large = TOPIX Core30・Large70 / mid = TOPIX Mid400 / small = それより小さい / any = 指定なし。`;
UNIVERSE_PROMPTS["universe-jp-v1"] = { system: UNIVERSE_JP_V1_SYSTEM };

const SuggestionJp = z.object({
  candidates: z
    .array(z.object({
      ticker: z.string().describe("東証の 4 文字の証券コード（例 7203, 130A）"),
      name: z.string().describe("ニュースで使われる通称（例 トヨタ, ソニーグループ）"),
      aliases: z.array(z.string()).max(4).default([]).describe("英語名・略称（任意）"),
      sector: z.enum(SECTORS),
      reason: z.string().max(200).describe("テーマとの関係を日本語で1文"),
    }))
    .max(40),
});

export interface Listing {
  ticker: string;
  cik: number;
  name: string;
  exchange: string;
}

export type CandidateStatus = "ok" | "unverified" | "rejected";

export interface Candidate {
  ticker: string;
  name: string;
  aliases: string[];
  sector: (typeof SECTORS)[number];
  reason: string;
  status: CandidateStatus;
  /** Why it is unverified or rejected. */
  problem: string | null;
  listing: Listing | null;
}

export interface SuggestResult {
  theme: string;
  model: string;
  candidates: Candidate[];
  /** The listing used for the check; unavailable (no key / unreachable): nothing is "ok". */
  verification: "sec" | "jquants" | "unavailable";
  verificationError: string | null;
}

const CORPORATE = new Set(["inc", "incorporated", "corp", "corporation", "co", "company", "companies", "holdings", "holding", "group", "plc", "ltd", "limited", "the", "class", "a", "b", "c", "de", "sa", "nv", "lp", "llc", "and"]);
const tokens = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t && !CORPORATE.has(t));

/** Does the suggested name plausibly belong to the listed company (catches a ticker paired with the wrong company)? */
export function namesMatch(suggested: string, official: string): boolean {
  const a = tokens(suggested);
  const b = tokens(official);
  if (!a.length || !b.length) return false;
  const joinedA = a.join("");
  const joinedB = b.join("");
  return b.includes(a[0]!) || a.includes(b[0]!) || joinedB.startsWith(joinedA) || joinedA.startsWith(joinedB);
}

const EXCHANGES = /^(nasdaq|nyse)/i;

/** Ticker in our form: upper case, class shares with a dot (SEC lists BRK-B). */
export const normTicker = (t: string) => t.trim().toUpperCase().replace(/-/g, ".");

/** The SEC list of listed companies (ticker, CIK, name, exchange), cached for a week. */
export async function secListings(s: Services, sec: SecClient, now: Date = new Date()): Promise<Map<string, Listing>> {
  s.db.exec(`CREATE TABLE IF NOT EXISTS sec_listings (ticker TEXT PRIMARY KEY, cik INT, name TEXT, exchange TEXT);
             CREATE TABLE IF NOT EXISTS sec_listings_meta (id INT PRIMARY KEY, fetched_at TEXT);`);
  const meta = s.db.prepare("SELECT fetched_at FROM sec_listings_meta WHERE id = 1").get() as { fetched_at: string } | undefined;
  const fresh = meta && now.getTime() - Date.parse(meta.fetched_at) < 7 * 86_400_000;
  if (!fresh) {
    const body = (await sec.json("https://www.sec.gov/files/company_tickers_exchange.json")) as { fields?: string[]; data?: unknown[][] };
    const f = body.fields ?? [];
    const [ci, ni, ti, ei] = ["cik", "name", "ticker", "exchange"].map((k) => f.indexOf(k)) as [number, number, number, number];
    if ([ci, ni, ti, ei].some((i) => i < 0) || !Array.isArray(body.data)) throw new Error("unexpected format of company_tickers_exchange.json");
    const ins = s.db.prepare("INSERT OR REPLACE INTO sec_listings VALUES (?,?,?,?)");
    s.db.exec("BEGIN");
    try {
      s.db.exec("DELETE FROM sec_listings");
      for (const row of body.data) {
        const t = normTicker(String(row[ti] ?? ""));
        if (t) ins.run(t, Number(row[ci]), String(row[ni] ?? ""), String(row[ei] ?? ""));
      }
      s.db.prepare("INSERT OR REPLACE INTO sec_listings_meta VALUES (1, ?)").run(now.toISOString());
      s.db.exec("COMMIT");
    } catch (e) {
      s.db.exec("ROLLBACK");
      throw e;
    }
  }
  const rows = s.db.prepare("SELECT ticker, cik, name, exchange FROM sec_listings").all() as unknown as Listing[];
  return new Map(rows.map((r) => [r.ticker, r]));
}

/** Checks one suggestion against the listings. */
export function verify(c: Omit<Candidate, "status" | "problem" | "listing">, listings: Map<string, Listing> | null, exclude: Set<string>): Candidate {
  const ticker = normTicker(c.ticker);
  const base = { ...c, ticker, listing: null as Listing | null };
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(ticker)) return { ...base, status: "rejected", problem: "ティッカーの形式が不正" };
  if (exclude.has(ticker)) return { ...base, status: "rejected", problem: "すでにウォッチリストにある" };
  if (!listings) return { ...base, status: "unverified", problem: "SEC の上場企業リストで確認できていない" };
  const l = listings.get(ticker);
  if (!l) return { ...base, status: "rejected", problem: "SEC の上場企業リストに無い（誤り・上場廃止・社名変更の可能性）" };
  if (!EXCHANGES.test(l.exchange)) return { ...base, listing: l, status: "rejected", problem: `NYSE / Nasdaq ではない（${l.exchange || "取引所不明"}）` };
  if (!namesMatch(c.name, l.name)) return { ...base, listing: l, status: "rejected", problem: `ティッカー ${ticker} は「${l.name}」で、提案の「${c.name}」と一致しない` };
  return { ...base, listing: l, status: "ok", problem: null };
}

export async function suggestTickers(s: Services, req: SuggestRequest, now: Date = new Date(), promptVersion?: string, model?: string): Promise<SuggestResult> {
  // finds US stocks (verified against SEC listings); they join the US part of the watchlist whatever the default market is
  const r = SuggestRequest.parse(req);
  if (r.market === "jp") return suggestJp(s, r, now, promptVersion, model);
  const bench = s.market("us").benchmark;
  const exclude = new Set([...s.watchlist.tickers, ...(bench ? [bench] : [])].map(normTicker));
  const p: LLMProvider = s.universeModel(model);
  // Ask for a few extra: some will fail verification.
  const want = Math.min(40, Math.ceil(r.count * 1.5));
  const user =
    `# 銘柄探し\nテーマ: ${r.theme}\n規模の希望: ${r.size}\n候補数: ${want}\n` +
    `除外: ${[...exclude].sort().join(", ") || "なし"}\n参考: 今のウォッチリストのセクター構成 ${JSON.stringify(sectorCounts(s))}`;
  const prompt = s.prompts.universe(promptVersion ?? s.config.prompts.universe ?? SUGGEST_PROMPT_VERSION);
  const out = await s.caller.call(p, Suggestion, { schemaName: "UniverseSuggestion", system: prompt.system, user, promptVersion: prompt.version });
  if (!out.value) throw new Error(`model gave no usable answer: ${out.error ?? "unknown"}`);

  let listings: Map<string, Listing> | null = null;
  let verificationError: string | null = null;
  const ua = s.env["SEC_USER_AGENT"];
  if (!ua) verificationError = "SEC_USER_AGENT が未設定のため、実在確認をしていません（設定画面で入力）";
  else {
    try {
      listings = await secListings(s, new SecClient({ userAgent: ua, fetchImpl: s.fetch, sleep: s.sleep }), now);
    } catch (e) {
      verificationError = `SEC のリストを取得できませんでした: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const c of out.value.candidates) {
    const v = verify({ ...c, name: c.name.trim(), aliases: c.aliases.map((a) => a.trim()).filter(Boolean), reason: c.reason.trim() }, listings, exclude);
    if (seen.has(v.ticker)) continue;
    seen.add(v.ticker);
    candidates.push(v);
  }
  // Verified first; then cap the verified ones at what was asked for.
  const ok = candidates.filter((c) => c.status !== "rejected").slice(0, r.count);
  const rejected = candidates.filter((c) => c.status === "rejected");
  return { theme: r.theme, model: p.model, candidates: [...ok, ...rejected], verification: listings ? "sec" : "unavailable", verificationError };
}

/** Japanese stocks: same flow, TSE codes checked against the J-Quants listing. */
async function suggestJp(s: Services, r: z.output<typeof SuggestRequest>, now: Date, promptVersion?: string, model?: string): Promise<SuggestResult> {
  const bench = s.market("jp").benchmark;
  const exclude = new Set([...s.watchlist.tickers, ...(bench ? [bench] : [])]);
  const p: LLMProvider = s.universeModel(model);
  const want = Math.min(40, Math.ceil(r.count * 1.5));
  const user =
    `# 銘柄探し（日本株・東証）\nテーマ: ${r.theme}\n規模の希望: ${r.size}\n候補数: ${want}\n` +
    `除外: ${[...exclude].filter((t) => /^\d{3}[0-9A-Z]$/.test(t)).sort().join(", ") || "なし"}\n参考: 今のウォッチリスト（日本株）のセクター構成 ${JSON.stringify(sectorCounts(s, "jp"))}`;
  const prompt = s.prompts.universe(promptVersion?.startsWith("universe-jp") ? promptVersion : "universe-jp-v1");
  const out = await s.caller.call(p, SuggestionJp, { schemaName: "UniverseSuggestionJp", system: prompt.system, user, promptVersion: prompt.version });
  if (!out.value) throw new Error(`model gave no usable answer: ${out.error ?? "unknown"}`);
  let listings: Map<string, JpListing> | null = null;
  let verificationError: string | null = null;
  try {
    listings = await jpListings(s, now);
  } catch (e) {
    verificationError = e instanceof Error ? e.message : String(e);
  }
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const c of out.value.candidates) {
    const v = verifyJp(c.ticker, c.name.trim(), listings, exclude);
    if (seen.has(v.ticker)) continue;
    seen.add(v.ticker);
    candidates.push({
      ticker: v.ticker, name: c.name.trim(), aliases: c.aliases.map((a) => a.trim()).filter(Boolean), sector: c.sector, reason: c.reason.trim(),
      status: v.status, problem: v.problem, listing: v.listing ? { ticker: v.ticker, cik: 0, name: v.listing.name, exchange: `東証${v.listing.segmentName}` } : null,
    });
  }
  const ok = candidates.filter((c) => c.status !== "rejected").slice(0, r.count);
  const rejected = candidates.filter((c) => c.status === "rejected");
  return { theme: r.theme, model: p.model, candidates: [...ok, ...rejected], verification: listings ? "jquants" : "unavailable", verificationError };
}

function sectorCounts(s: Services, market: "us" | "jp" = "us"): Record<string, number> {
  const out: Record<string, number> = {};
  const w = s.watchlistFor(market);
  for (const t of w.tickers) out[w.sector(t)] = (out[w.sector(t)] ?? 0) + 1;
  return out;
}
