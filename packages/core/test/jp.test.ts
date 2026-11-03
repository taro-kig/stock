import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { convert, latestUsdJpy, refreshUsdJpy } from "../src/data/fx.ts";
import { Services } from "../src/services.ts";
import { jpListings, jpNamesMatch, parseJpMaster, screenJpStocks, verifyJp } from "../src/universe/jp.ts";
import { suggestTickers } from "../src/universe/suggest.ts";
import { weekdays } from "../src/util/dates.ts";

const master = {
  data: [
    { Date: "2026-11-02", Code: "72030", CoName: "トヨタ自動車", CoNameEn: "TOYOTA MOTOR CORPORATION", S17Nm: "自動車・輸送機", S33Nm: "輸送用機器", ScaleCat: "TOPIX Core30", Mkt: "0111" },
    { Date: "2026-11-02", Code: "67580", CoName: "ソニーグループ", CoNameEn: "Sony Group Corporation", S17Nm: "電機・精密", S33Nm: "電気機器", ScaleCat: "TOPIX Core30", Mkt: "0111" },
    { Date: "2026-11-02", Code: "80350", CoName: "東京エレクトロン", CoNameEn: "Tokyo Electron Limited", S17Nm: "電機・精密", S33Nm: "電気機器", ScaleCat: "TOPIX Core30", Mkt: "0111" },
    { Date: "2026-11-02", Code: "130A0", CoName: "ベリフォーマ", CoNameEn: "Veritas In Silico", S17Nm: "医薬品", S33Nm: "医薬品", ScaleCat: "-", Mkt: "0113" },
    { Date: "2026-11-02", Code: "65010", CoName: "日立製作所", CoNameEn: "Hitachi,Ltd.", S17Nm: "電機・精密", S33Nm: "電気機器", ScaleCat: "TOPIX Core30", Mkt: "0111" },
    { Date: "2026-11-02", Code: "99990", CoName: "テストプロ", CoNameEn: "Test Pro", S17Nm: "小売", S33Nm: "小売業", ScaleCat: "-", Mkt: "0105" },
    // mid / small for the screen
    { Date: "2026-11-02", Code: "11110", CoName: "中型電機", CoNameEn: "Mid Elec", S17Nm: "電機・精密", S33Nm: "電気機器", ScaleCat: "TOPIX Mid400", Mkt: "0111" },
    { Date: "2026-11-02", Code: "22220", CoName: "小型電機", CoNameEn: "Small Elec", S17Nm: "電機・精密", S33Nm: "電気機器", ScaleCat: "TOPIX Small 1", Mkt: "0112" },
    { Date: "2026-11-02", Code: "33330", CoName: "薄商い電機", CoNameEn: "Thin Elec", S17Nm: "電機・精密", S33Nm: "電気機器", ScaleCat: "TOPIX Small 2", Mkt: "0112" },
    { Date: "2026-11-02", Code: "44440", CoName: "下落電機", CoNameEn: "Falling Elec", S17Nm: "電機・精密", S33Nm: "電気機器", ScaleCat: "TOPIX Mid400", Mkt: "0111" },
  ],
};

const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });

describe("J-Quants listing", () => {
  it("reads v2 master records: 4-character codes, segments, sectors", () => {
    const { rows, next } = parseJpMaster({ ...master, pagination_key: "k1" });
    expect(next).toBe("k1");
    const by = Object.fromEntries(rows.map((r) => [r.ticker, r]));
    expect(by["7203"]).toMatchObject({ name: "トヨタ自動車", segment: "prime", segmentName: "プライム", sector17: "自動車・輸送機", scale: "TOPIX Core30" });
    expect(by["130A"]).toMatchObject({ segment: "growth" });
    expect(by["9999"]!.segment).toBeNull(); // TOKYO PRO Market
  });

  it("matches short Japanese or English names and rejects wrong pairings", () => {
    const toyota = { name: "トヨタ自動車", nameEn: "TOYOTA MOTOR CORPORATION" };
    expect(jpNamesMatch("トヨタ", toyota)).toBe(true);
    expect(jpNamesMatch("Toyota Motor", toyota)).toBe(true);
    expect(jpNamesMatch("ソニー", toyota)).toBe(false);
    expect(jpNamesMatch("日立", { name: "日立製作所", nameEn: "Hitachi,Ltd." })).toBe(true);
    const listings = new Map(parseJpMaster(master).rows.map((r) => [r.ticker, r]));
    expect(verifyJp("７２０３", "トヨタ", listings, new Set())).toMatchObject({ ticker: "7203", status: "ok" });
    expect(verifyJp("6758", "トヨタ", listings, new Set()).problem).toMatch(/一致しない/);
    expect(verifyJp("9999", "テストプロ", listings, new Set()).problem).toMatch(/プライム・スタンダード・グロース以外/);
    expect(verifyJp("1234", "x", listings, new Set()).problem).toMatch(/一覧に無い/);
    expect(verifyJp("AAPL", "Apple", listings, new Set()).status).toBe("rejected");
    expect(verifyJp("7203", "トヨタ", null, new Set()).status).toBe("unverified");
  });
});

function jpServices(env: Record<string, string>, fetchImpl: typeof fetch) {
  return new Services(
    AppConfig.parse({ market: { currency: "JPY", benchmark: "1306" }, risk: { lotSize: 100 }, watchlist: { "7203": { name: "トヨタ自動車", sector: "auto" } } }),
    { fake: true, dbPath: ":memory:", env, sleep: async () => undefined, fetchImpl },
  );
}

describe("AI suggestions for Japanese stocks", () => {
  it("proposes TSE codes and checks them against the J-Quants listing (cached)", async () => {
    let calls = 0;
    const s = jpServices({ JQUANTS_API_KEY: "k" }, async (url) => {
      calls++;
      expect(String(url)).toContain("/v2/equities/master");
      return json(master);
    });
    const r = await suggestTickers(s, { theme: "半導体", count: 5, market: "jp" }, new Date("2026-11-03T00:00:00Z"));
    expect(r.verification).toBe("jquants");
    const by = Object.fromEntries(r.candidates.map((c) => [c.ticker, c]));
    expect(by["8035"]).toMatchObject({ status: "ok", listing: { exchange: "東証プライム" } });
    expect(by["6758"]!.status).toBe("ok");
    expect(by["7203"]).toBeUndefined(); // already watched: excluded from the request
    expect(by["4063"]!.status).toBe("rejected"); // not in this (test) listing
    await jpListings(s, new Date("2026-11-04T00:00:00Z"));
    expect(calls).toBe(1);
  });

  it("without a J-Quants key nothing is marked verified", async () => {
    const s = jpServices({}, async () => json(master));
    const r = await suggestTickers(s, { theme: "半導体", count: 3, market: "jp" });
    expect(r.verification).toBe("unavailable");
    expect(r.verificationError).toMatch(/JQUANTS_API_KEY/);
    expect(r.candidates.every((c) => c.status !== "ok")).toBe(true);
  });
});

describe("data screen for Japanese stocks", () => {
  // daily closes per code: up-trending, flat, thinly traded, falling
  const days = weekdays("2025-06-02", "2026-10-30");
  const path: Record<string, (i: number) => number> = {
    "11110": (i) => 1000 * (1 + i * 0.002),
    "22220": (i) => 800 * (1 + i * 0.001),
    "33330": (i) => 500 * (1 + i * 0.003),
    "44440": (i) => 2000 * (1 - i * 0.0012),
  };
  const volume: Record<string, number> = { "11110": 500_000, "22220": 400_000, "33330": 1_000, "44440": 300_000 };
  const row = (code: string, i: number) => {
    const c = path[code]!(i);
    return { Date: days[i], Code: code, AdjO: c, AdjH: c, AdjL: c, AdjC: c, AdjVo: volume[code] };
  };

  it("narrows by segment / size / sector, pre-ranks everyone on three dates, then ranks the short list", async () => {
    const urls: string[] = [];
    const s = jpServices({ JQUANTS_API_KEY: "k" }, async (u) => {
      const url = new URL(String(u));
      urls.push(url.pathname + url.search);
      if (url.pathname === "/v2/equities/master") return json(master);
      const date = url.searchParams.get("date");
      if (date) {
        const i = days.indexOf(date);
        return json({ data: i < 0 ? [] : Object.keys(path).map((code) => row(code, i)) });
      }
      const code = url.searchParams.get("code")!;
      return json({ data: days.map((_, i) => row(`${code}0`, i)) });
    });
    const r = await screenJpStocks(s, { segments: ["prime", "standard"], sizes: ["mid", "small"], sectors: ["電機・精密"], count: 5, maxPriceLookups: 3 }, { now: new Date("2026-10-31T09:00:00Z") });
    expect(r.funnel[1]!.count).toBe(4); // the four mid / small 電機・精密 stocks
    expect(r.funnel[2]!.count).toBe(3); // 3333 is too thin on the one-day check
    expect(r.candidates.map((c) => c.ticker)).toEqual(["1111", "2222", "4444"]); // the falling one ranks last
    expect(r.candidates[0]).toMatchObject({ exchange: "東証プライム", sector: "電機・精密", bucket: "mid" });
    expect(r.candidates[0]!.reason).toMatch(/12-1モメンタム \+/);
    expect(urls.filter((u) => u.includes("code=")).length).toBe(3);
  });
});

describe("USD/JPY", () => {
  it("downloads the rate once a day (Twelve Data) and converts", async () => {
    let calls = 0;
    const s = jpServices({ TWELVEDATA_API_KEY: "k" }, async (u) => {
      calls++;
      expect(new URL(String(u)).searchParams.get("symbol")).toBe("USD/JPY");
      return json({ values: [{ datetime: "2026-10-29", open: "151", high: "152", low: "150", close: "151.5" }, { datetime: "2026-10-30", open: "152", high: "153", low: "151", close: "152.25" }] });
    });
    expect(latestUsdJpy(s)).toBeNull();
    expect((await refreshUsdJpy(s, new Date("2026-10-31T00:00:00Z"))).status).toBe("updated");
    expect(latestUsdJpy(s)).toEqual({ rate: 152.25, date: "2026-10-30" });
    expect((await refreshUsdJpy(s, new Date("2026-10-31T05:00:00Z"))).status).toBe("fresh");
    expect(calls).toBe(1);
    expect(convert(100, "USD", "JPY", 150)).toBe(15000);
    expect(convert(15000, "JPY", "USD", 150)).toBe(100);
  });

  it("says why when no key can fetch it", async () => {
    const s = jpServices({}, async () => json({}));
    expect((await refreshUsdJpy(s, new Date())).status).toBe("unavailable");
  });
});
