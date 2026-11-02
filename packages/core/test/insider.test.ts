import { describe, expect, it } from "vitest";
import { buildDossier } from "../src/ai/judge.ts";
import { AppConfig } from "../src/config.ts";
import { insiderScore, InsiderStore, parseForm4, rawForm4Document, summarizeInsider, type InsiderTrade } from "../src/data/insider.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { openDb } from "../src/util/db.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

const form4 = (o: { owner: string; title?: string; director?: boolean; code: string; date: string; shares: number; price: number; plan?: boolean; symbol?: string }) => `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0508</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>${o.date}</periodOfReport>
  <aff10b5One>${o.plan ? 1 : 0}</aff10b5One>
  <issuer><issuerCik>0000320193</issuerCik><issuerName>Apple Inc.</issuerName><issuerTradingSymbol>${o.symbol ?? "AAPL"}</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001</rptOwnerCik><rptOwnerName>${o.owner}</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>${o.director ? 1 : 0}</isDirector><isOfficer>${o.title ? 1 : 0}</isOfficer>${o.title ? `<officerTitle>${o.title}</officerTitle>` : ""}<isTenPercentOwner>0</isTenPercentOwner><isOther>0</isOther></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>${o.date}</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${o.code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>${o.shares}</value></transactionShares>
        <transactionPricePerShare><value>${o.price}</value><footnoteId id="F1"/></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>${o.code === "S" ? "D" : "A"}</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>50000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const T = (owner: string, code: string, date: string, value: number, plan = false): InsiderTrade => ({
  accession: `${owner}-${date}`, ticker: "AAPL", owner, title: "CFO", officer: true, director: false, tenPercent: false,
  code, date, shares: value / 100, price: 100, value, plan, filedAt: `${date}T22:00:00.000Z`,
});

describe("Form 4", () => {
  it("parses the ownership document", () => {
    const t = parseForm4(form4({ owner: "DOE JANE", title: "Chief Financial Officer", code: "P", date: "2026-10-28", shares: 5000, price: 150.25, plan: false }), { accession: "0001-26-000001", filedAt: "2026-10-29T21:00:00.000Z" });
    expect(t).toEqual([expect.objectContaining({ owner: "DOE JANE", title: "Chief Financial Officer", officer: true, code: "P", date: "2026-10-28", shares: 5000, price: 150.25, value: 751250, plan: false, ticker: "AAPL" })]);
    const d = parseForm4(form4({ owner: "ROE JOHN", director: true, code: "S", date: "2026-10-20", shares: 100, price: 200, plan: true }), { accession: "x", filedAt: "x" });
    expect(d[0]).toMatchObject({ title: "Director", director: true, code: "S", plan: true });
    expect(() => parseForm4("<html/>", { accession: "y", filedAt: "y" })).toThrow(/not a Form 4/);
    expect(rawForm4Document("xslF345X05/wk-form4_1700000000.xml")).toBe("wk-form4_1700000000.xml");
  });

  it("summarizes buying (clusters) and discounts planned sales", () => {
    const s = summarizeInsider("AAPL", [
      T("A", "P", "2026-10-01", 500_000), T("B", "P", "2026-10-10", 200_000), T("C", "P", "2026-10-20", 100_000),
      T("D", "S", "2026-10-15", 3_000_000, true), T("E", "S", "2026-10-16", 1_000_000),
    ], 90);
    expect(s).toMatchObject({ buys: 3, buyers: 3, buyValue: 800_000, sells: 2, sellers: 2, plannedSells: 1, cluster: true, lastBuy: "2026-10-20" });
    expect(s.topBuys[0]).toMatchObject({ owner: "A", value: 500_000 });
    expect(summarizeInsider("AAPL", [T("A", "P", "2026-08-01", 1), T("B", "P", "2026-10-10", 1), T("C", "P", "2026-10-20", 1)], 90).cluster).toBe(false);
    expect(insiderScore(s)).toBeGreaterThan(insiderScore(summarizeInsider("AAPL", [T("A", "P", "2026-10-01", 800_000)], 90)));
    expect(insiderScore(summarizeInsider("AAPL", [T("D", "S", "2026-10-15", 3_000_000)], 90))).toBe(0);
  });

  it("only counts trades public by the run time", () => {
    const st = new InsiderStore(openDb(":memory:"));
    st.save("a1", "AAPL", "2026-10-29T21:00:00.000Z", [T("A", "P", "2026-10-28", 500_000)]);
    expect(st.trades("AAPL", "2026-10-28", new Date("2026-10-28T23:59:59Z"), 90)).toHaveLength(0); // filed the next day
    expect(st.trades("AAPL", "2026-10-29", new Date("2026-10-29T23:59:59Z"), 90)).toHaveLength(1);
    expect(st.has("a1")).toBe(true);
  });

  it("the node downloads new Form 4s for the watchlist, stays green without a User-Agent", async () => {
    const urls: string[] = [];
    const setup = (env: Record<string, string>) => {
      const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { AAPL: { name: "Apple" } } }), {
        dbPath: ":memory:", env, sleep: async () => undefined,
        fetchImpl: async (u) => {
          const url = String(u);
          urls.push(url);
          if (url.endsWith("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }));
          if (url.includes("CIK0000320193")) {
            return new Response(JSON.stringify({ cik: 320193, name: "Apple Inc.", filings: { recent: {
              accessionNumber: ["0001-26-000002", "0001-26-000001", "0001-26-000000"], filingDate: ["2026-10-30", "2026-10-29", "2026-10-29"],
              acceptanceDateTime: ["2026-10-30T17:00:00.000Z", "2026-10-29T17:00:00.000Z", "2026-10-29T16:30:00.000Z"],
              form: ["4", "4", "8-K"], items: ["", "", "2.02"],
              primaryDocument: ["xslF345X05/b.xml", "xslF345X05/a.xml", "x.htm"], primaryDocDescription: ["", "", ""],
            } } }));
          }
          if (url.endsWith("/a.xml")) return new Response(form4({ owner: "DOE JANE", title: "CFO", code: "P", date: "2026-10-28", shares: 5000, price: 150 }));
          if (url.endsWith("/b.xml")) return new Response(form4({ owner: "ROE JOHN", director: true, code: "S", date: "2026-10-29", shares: 1000, price: 152, plan: true }));
          return new Response("nope", { status: 404 });
        },
      });
      return { s, engine: new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-10-30T22:30:00Z") }) };
    };
    const spec = parseWorkflow("name: t\nnodes:\n  i: { use: data.insider }\n");
    const { s, engine } = setup({ SEC_USER_AGENT: "stockai me@example.com" });
    const r = await engine.run(spec);
    expect(r.status).toBe("succeeded");
    const aapl = r.output<Record<string, { buys: number; sells: number; plannedSells: number; topBuys: Array<{ owner: string }> }>>("i", "insider")["AAPL"]!;
    expect(aapl).toMatchObject({ buys: 1, sells: 1, plannedSells: 1 });
    expect(aapl.topBuys[0]!.owner).toBe("DOE JANE");
    expect(urls.some((u) => u.endsWith("/000132019326000001/a.xml") || u.endsWith("/a.xml"))).toBe(true);
    // second run the same day for another workflow: no Form 4 downloaded again
    const before = urls.filter((u) => u.endsWith(".xml")).length;
    await engine.run(parseWorkflow("name: t2\nnodes:\n  i: { use: data.insider }\n"));
    expect(urls.filter((u) => u.endsWith(".xml")).length).toBe(before);
    expect(s.insider.has("0001-26-000002")).toBe(true);

    const none = setup({});
    const r2 = await none.engine.run(spec);
    expect(r2.status).toBe("succeeded");
    expect(r2.output("i", "insider")).toEqual({});
  });

  it("goes into the dossier and the composite score", async () => {
    const row = { ticker: "AAPL", name: "Apple", sector: "tech", close: 200, atr: 4, momentum: 0.2, relStrength: 0.05, vol: 0.25, trend: "up" as const, lastDate: "2026-10-30", ret20: null, fromHigh52: null };
    const base = { row, asOf: "2026-10-30", rank: 1, universe: 10, events: [] };
    expect(buildDossier(base).text).not.toContain("インサイダー");
    const s = summarizeInsider("AAPL", [T("JANE DOE", "P", "2026-10-28", 1_200_000), T("D", "S", "2026-10-15", 3_000_000, true)], 90);
    const text = buildDossier({ ...base, insider: s }).text;
    expect(text).toContain("## インサイダー売買（直近90日");
    expect(text).toContain("買い: 1人・1件・$1.2M");
    expect(text).toContain("- 2026-10-28 JANE DOE（CFO）$1.2M");
    expect(text).toContain("（うち1件は事前の売却計画 10b5-1）");
    expect(buildDossier({ ...base, insider: summarizeInsider("AAPL", [], 90) }).text).toContain("(なし)");
  });
});

describe("Schedule 13D", () => {
  it("is picked up by source.secFilings with a readable title", async () => {
    const s = new Services(AppConfig.parse({ market: { currency: "USD" }, watchlist: { AAPL: { name: "Apple" } } }), {
      dbPath: ":memory:", env: { SEC_USER_AGENT: "stockai me@example.com" }, sleep: async () => undefined,
      fetchImpl: async (u) => {
        const url = String(u);
        if (url.endsWith("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }));
        if (url.includes("CIK0000320193")) {
          return new Response(JSON.stringify({ cik: 320193, name: "Apple Inc.", filings: { recent: {
            accessionNumber: ["0009-26-000001"], filingDate: ["2026-10-29"], acceptanceDateTime: ["2026-10-29T16:00:00.000Z"],
            form: ["SCHEDULE 13D"], items: [""], primaryDocument: ["primary_doc.xml"], primaryDocDescription: ["SCHEDULE 13D"],
          } } }));
        }
        return new Response("<p>Item 4. Purpose of Transaction. The Reporting Persons intend to engage with the board regarding capital allocation.</p>");
      },
    });
    const r = await new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-10-30T12:00:00Z") })
      .run(parseWorkflow("name: t\nnodes:\n  sec: { use: source.secFilings }\n"));
    const docs = r.output<Array<{ title: string; body: string }>>("sec", "docs");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("Apple (AAPL) SCHEDULE 13D: Schedule 13D: beneficial ownership over 5% with intent to influence (activist / control)");
    expect(docs[0]!.body).toContain("Purpose of Transaction");
  });
});
