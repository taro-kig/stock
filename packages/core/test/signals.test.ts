import { describe, expect, it } from "vitest";
import { eventScores } from "../src/signals/aggregate.ts";
import { EventExtraction, type EventRecord } from "../src/signals/models.ts";
import { dedup, Watchlist } from "../src/signals/prefilter.ts";
import { parseFeed } from "../src/signals/rss.ts";
import { atr, momentum12_1, trendLabel, type Bar } from "../src/signals/technical.ts";
import { addDays } from "../src/util/dates.ts";
import { makeDoc } from "./helpers.ts";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Sony raises outlook - Reuters</title><link>https://r/1</link>
<description>&lt;b&gt;Sony&lt;/b&gt; Group lifted its forecast &amp;amp; more.</description>
<pubDate>Mon, 02 Nov 2026 06:00:00 GMT</pubDate></item></channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<entry><title>8-K filing</title><link href="https://sec/1"/><updated>2026-11-02T06:00:00Z</updated><summary>Item 2.02</summary></entry></feed>`;

describe("rss", () => {
  it("parses RSS 2.0", () => {
    const [d] = parseFeed(RSS, "reuters", { weight: 0.9 });
    expect(d?.title).toBe("Sony raises outlook - Reuters");
    expect(d?.body).toBe("Sony  Group lifted its forecast & more.");
    expect(d?.url).toBe("https://r/1");
    expect(d?.publishedAt).toBe("2026-11-02T06:00:00.000Z");
    expect(d?.sourceWeight).toBe(0.9);
  });
  it("parses Atom", () => {
    const [d] = parseFeed(ATOM, "sec");
    expect(d?.url).toBe("https://sec/1");
    expect(d?.body).toBe("Item 2.02");
  });
});

describe("prefilter (Tier 0)", () => {
  const w = new Watchlist({
    "6758": { name: "ソニーグループ", aliases: ["ソニー", "Sony"] },
    "7203": { name: "トヨタ自動車", aliases: ["トヨタ"] },
  });
  it("matches with word boundaries for ASCII aliases", () => {
    expect(w.match(makeDoc({ title: "SONY lifts outlook", body: "" }))).toEqual({ "6758": "ソニーグループ" });
    expect(w.match(makeDoc({ title: "Sonya's bakery", body: "" }))).toEqual({});
    expect(Object.keys(w.match(makeDoc({ title: "トヨタが新型車", body: "" })))).toEqual(["7203"]);
  });
  it("dedups syndicated stories and records corroboration", () => {
    const out = dedup([makeDoc({ source: "nikkei", title: "トヨタ、上方修正 - 日経" }), makeDoc({ source: "yahoo", title: "トヨタ、上方修正 - Yahoo!ニュース" })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.alsoSeenIn).toEqual(["yahoo"]);
  });
});

const rec = (learnedAt: string, nSources = 1): EventRecord => ({
  docHash: "h", title: "t", url: "u", source: "s", learnedAt, agreement: 1, sourceWeight: 1, nSources,
  event: EventExtraction.parse({ relevant: true, tickers: ["7203"], eventType: "guidance_up", direction: 2, materiality: 3, horizon: "months", confidence: 1, evidence: ["x".repeat(10)] }),
});

describe("eventScores", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  it("decays by half-life, rewards corroboration, ignores the future", () => {
    const fresh = eventScores([rec(now.toISOString())], now)["7203"]!;
    const old = eventScores([rec("2026-10-02T00:00:00Z")], now)["7203"]!;
    expect(old).toBeCloseTo(fresh / 2);
    expect(eventScores([rec(now.toISOString(), 2)], now)["7203"]).toBeGreaterThan(fresh);
    expect(eventScores([rec("2026-11-02T00:00:00Z")], now)).toEqual({});
  });
});

describe("technical", () => {
  const bars: Bar[] = Array.from({ length: 300 }, (_, i) => {
    const c = 100 + (100 * i) / 299;
    return { date: addDays("2025-01-01", i), open: c, high: c + 1, low: c - 1, close: c, volume: 1 };
  });
  it("computes trend, momentum and ATR", () => {
    expect(trendLabel(bars)).toBe("up");
    expect(trendLabel([...bars].reverse().map((b, i) => ({ ...b, date: addDays("2025-01-01", i) })))).toBe("down");
    expect(momentum12_1(bars)).toBeGreaterThan(0);
    const a = atr(bars);
    expect(a).toBeGreaterThanOrEqual(2);
    expect(a).toBeLessThanOrEqual(2.5);
  });
});
