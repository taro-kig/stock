import { XMLParser } from "fast-xml-parser";
import type { Document } from "./models.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function cleanHtml(s: unknown): string {
  const text = typeof s === "string" ? s : s && typeof s === "object" && "#text" in s ? String((s as { "#text": unknown })["#text"]) : "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e.startsWith("#") ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .trim();
}

function toIso(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

type Obj = Record<string, unknown>;

/** Parses RSS 2.0 or Atom into Documents. Prefer official feeds/APIs over scraping (DESIGN §13). */
export function parseFeed(xml: string, source: string, opts: { weight?: number; fetchedAt?: Date } = {}): Document[] {
  const root = parser.parse(xml) as Obj;
  const fetchedAt = (opts.fetchedAt ?? new Date()).toISOString();
  const base = { source, sourceWeight: opts.weight ?? 1, fetchedAt, alsoSeenIn: [] };
  const rss = (root["rss"] as Obj | undefined)?.["channel"] as Obj | undefined;
  if (rss) {
    return ((rss["item"] as Obj[] | undefined) ?? []).map((it) => ({
      ...base,
      url: cleanHtml((it["link"] as unknown[] | undefined)?.[0]),
      title: cleanHtml(it["title"]),
      body: cleanHtml(it["description"]),
      publishedAt: toIso(it["pubDate"]),
    }));
  }
  const feed = root["feed"] as Obj | undefined;
  if (feed) {
    return ((feed["entry"] as Obj[] | undefined) ?? []).map((it) => {
      const links = (it["link"] as Obj[] | undefined) ?? [];
      return {
        ...base,
        url: String(links[0]?.["@href"] ?? ""),
        title: cleanHtml(it["title"]),
        body: cleanHtml(it["summary"] ?? it["content"]),
        publishedAt: toIso(it["published"] ?? it["updated"]),
      };
    });
  }
  throw new Error("unrecognized feed format");
}

export async function fetchFeed(url: string, source: string, opts: { weight?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<Document[]> {
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { "user-agent": "stockai/0.1 (personal research)" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return parseFeed(await res.text(), source, opts);
}
