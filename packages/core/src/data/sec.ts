/**
 * SEC EDGAR (free, no key). Fair-access rules: a descriptive User-Agent with a contact
 * e-mail, at most 10 requests/second (https://www.sec.gov/os/accessing-edgar-data).
 */

export const SEC_ITEMS: Readonly<Record<string, string>> = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "1.05": "Material Cybersecurity Incidents",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Direct Financial Obligation",
  "2.04": "Triggering Events That Accelerate a Financial Obligation",
  "2.05": "Costs Associated with Exit or Disposal Activities",
  "2.06": "Material Impairments",
  "3.01": "Notice of Delisting or Failure to Satisfy a Listing Rule",
  "3.02": "Unregistered Sales of Equity Securities",
  "3.03": "Material Modification to Rights of Security Holders",
  "4.01": "Changes in Registrant's Certifying Accountant",
  "4.02": "Non-Reliance on Previously Issued Financial Statements",
  "5.01": "Changes in Control of Registrant",
  "5.02": "Departure or Election of Directors or Officers",
  "5.03": "Amendments to Articles or Bylaws; Change in Fiscal Year",
  "5.07": "Submission of Matters to a Vote of Security Holders",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
  "9.01": "Financial Statements and Exhibits",
};

export interface Filing {
  cik: number;
  accession: string;
  form: string;
  filingDate: string;
  /** UTC instant the filing became public (see parseSubmissions about the time zone). */
  acceptedAt: string;
  items: string[];
  primaryDocument: string;
  description: string;
  url: string;
}

type Obj = Record<string, unknown>;

/** UTC offset of New York at the given instant, in minutes (−240 in summer, −300 in winter). */
function nyOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "2026-07-30T16:31:02" read as New York wall-clock time → UTC ISO string. */
export function newYorkToUtc(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(local);
  if (!m) throw new Error(`bad EDGAR time ${local}`);
  const naive = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  // Two passes settle the offset across DST changes.
  let t = naive - nyOffsetMinutes(new Date(naive)) * 60_000;
  t = naive - nyOffsetMinutes(new Date(t)) * 60_000;
  return new Date(t).toISOString();
}

export const accessionPath = (cik: number, accession: string) => `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}`;

/**
 * Parses data.sec.gov/submissions/CIK##########.json (the "recent" block).
 * EDGAR's `acceptanceDateTime` carries a "Z" but the clock reads US Eastern time
 * (an 8-K accepted at 16:30 New York time shows as 16:30Z), so it is read as New York
 * time. If that ever turns out wrong, the error makes events look *later*, never earlier
 * (no look-ahead).
 */
export function parseSubmissions(body: unknown): { name: string; filings: Filing[] } {
  const o = (body ?? {}) as Obj;
  const cik = Number(o["cik"]);
  const recent = ((o["filings"] as Obj | undefined)?.["recent"] ?? {}) as Record<string, unknown[]>;
  const col = (k: string) => (Array.isArray(recent[k]) ? recent[k] : []);
  const acc = col("accessionNumber");
  if (!Number.isFinite(cik) || !acc.length) return { name: String(o["name"] ?? ""), filings: [] };
  const filings: Filing[] = [];
  for (let i = 0; i < acc.length; i++) {
    const accession = String(acc[i]);
    const accepted = String(col("acceptanceDateTime")[i] ?? "");
    const filingDate = String(col("filingDate")[i] ?? "");
    const primaryDocument = String(col("primaryDocument")[i] ?? "");
    let acceptedAt: string;
    try {
      acceptedAt = newYorkToUtc(accepted);
    } catch {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(filingDate)) continue;
      acceptedAt = newYorkToUtc(`${filingDate}T23:59:59`); // date only: assume the end of the day
    }
    filings.push({
      cik, accession, form: String(col("form")[i] ?? ""), filingDate, acceptedAt,
      items: String(col("items")[i] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
      primaryDocument, description: String(col("primaryDocDescription")[i] ?? ""),
      url: `${accessionPath(cik, accession)}/${primaryDocument}`,
    });
  }
  return { name: String(o["name"] ?? ""), filings };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", bull: "•" };

/** Filing HTML → plain text (drops scripts, styles and the hidden inline-XBRL header). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|ix:header)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

/** The press-release exhibit (EX-99.x) of a filing, if listed in its index. */
export function pickExhibit(index: unknown): string | undefined {
  const items = (((index as Obj | undefined)?.["directory"] as Obj | undefined)?.["item"] ?? []) as Obj[];
  const names = Array.isArray(items) ? items.map((i) => String(i["name"] ?? "")) : [];
  return names.filter((n) => /\.html?$/i.test(n) && /ex[-_]?99/i.test(n)).sort()[0];
}

export interface SecClientOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  /** Spacing between requests (SEC allows 10/s; stay well below). */
  minIntervalMs?: number;
}

export class SecClient {
  readonly #o: Required<SecClientOptions>;
  #last = Number.NEGATIVE_INFINITY;

  constructor(o: SecClientOptions) {
    if (!/@/.test(o.userAgent)) throw new Error("SEC requires a User-Agent with a contact e-mail, e.g. \"stockai you@example.com\"");
    this.#o = {
      userAgent: o.userAgent,
      fetchImpl: o.fetchImpl ?? ((i, init) => fetch(i, init)),
      sleep: o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      clock: o.clock ?? Date.now,
      minIntervalMs: o.minIntervalMs ?? 150,
    };
  }

  async #get(url: string): Promise<Response> {
    const wait = this.#last + this.#o.minIntervalMs - this.#o.clock();
    if (wait > 0) await this.#o.sleep(wait);
    this.#last = this.#o.clock();
    let res: Response;
    try {
      res = await this.#o.fetchImpl(url, { headers: { "user-agent": this.#o.userAgent, accept: "application/json, text/html;q=0.9" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      throw new Error(`cannot reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}${cause}`);
    }
    if (res.status === 403) throw new Error(`SEC refused ${url} (403): check the User-Agent and the request rate`);
    if (!res.ok) throw new Error(`SEC ${url}: HTTP ${res.status}`);
    return res;
  }

  async json(url: string): Promise<unknown> {
    return (await this.#get(url)).json();
  }

  async text(url: string): Promise<string> {
    return (await this.#get(url)).text();
  }

  /** Ticker (upper case, "BRK.B" style) → CIK, from www.sec.gov/files/company_tickers.json. */
  async tickerMap(): Promise<Record<string, number>> {
    const body = (await this.json("https://www.sec.gov/files/company_tickers.json")) as Record<string, Obj>;
    const out: Record<string, number> = {};
    for (const r of Object.values(body ?? {})) {
      const t = String(r["ticker"] ?? "").toUpperCase();
      const cik = Number(r["cik_str"]);
      if (t && Number.isFinite(cik)) out[t.replace(/-/g, ".")] = cik;
    }
    return out;
  }

  async submissions(cik: number): Promise<{ name: string; filings: Filing[] }> {
    return parseSubmissions(await this.json(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`));
  }

  /** Plain text of a filing: the primary document, plus the press-release exhibit if there is one. */
  async filingText(f: Filing, maxChars: number): Promise<string> {
    const primary = htmlToText(await this.text(f.url));
    let exhibit = "";
    try {
      const ex = pickExhibit(await this.json(`${accessionPath(f.cik, f.accession)}/index.json`));
      if (ex) exhibit = htmlToText(await this.text(`${accessionPath(f.cik, f.accession)}/${ex}`));
    } catch {
      // the index is a convenience; the primary document alone is still useful
    }
    if (!exhibit) return primary.slice(0, maxChars);
    const head = primary.slice(0, Math.min(1500, Math.floor(maxChars / 4)));
    return `${head}\n\n--- Exhibit 99 ---\n${exhibit}`.slice(0, maxChars);
  }
}
