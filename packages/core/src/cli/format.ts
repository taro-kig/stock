/** Small terminal renderer: box tables + status colours (the web UI will reuse the same data). */
const tty = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
const esc = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { dim: esc("2"), bold: esc("1"), red: esc("31"), green: esc("32"), yellow: esc("33"), blue: esc("34"), cyan: esc("36"), magenta: esc("35") };

const ANSI = /\x1b\[[0-9;]*m/g;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** Display width: CJK characters take two cells. */
export function width(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI, "")) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

const pad = (s: string, n: number, right = false) => {
  const fill = " ".repeat(Math.max(0, n - width(s)));
  return right ? fill + s : s + fill;
};

export function table(headers: string[], rows: string[][], opts: { right?: number[] } = {}): string {
  const w = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ""))));
  const line = (l: string, m: string, r: string) => c.dim(l + w.map((n) => "─".repeat(n + 2)).join(m) + r);
  const row = (cells: string[]) => c.dim("│") + cells.map((s, i) => ` ${pad(s, w[i]!, opts.right?.includes(i))} `).join(c.dim("│")) + c.dim("│");
  return [line("┌", "┬", "┐"), row(headers.map((h) => c.bold(h))), line("├", "┼", "┤"), ...rows.map(row), line("└", "┴", "┘")].join("\n");
}

const STATUS: Record<string, (s: string) => string> = {
  ok: (s) => c.green(`● ${s}`),
  succeeded: (s) => c.green(`● ${s}`),
  cached: (s) => c.cyan(`◆ ${s}`),
  fallback: (s) => c.yellow(`◐ ${s}`),
  partial: (s) => c.yellow(`◐ ${s}`),
  waiting: (s) => c.magenta(`◌ ${s}`),
  pending: (s) => c.dim(`○ ${s}`),
  skipped: (s) => c.dim(`○ ${s}`),
  failed: (s) => c.red(`✕ ${s}`),
  running: (s) => c.blue(`▶ ${s}`),
};
export const status = (s: string): string => (STATUS[s] ?? ((x: string) => x))(s);

const isNum = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
export const num = (x: number | null | undefined, digits = 2): string => (isNum(x) ? x.toFixed(digits) : "—");
export const pct = (x: number | null | undefined, digits = 1): string => (isNum(x) ? `${(x * 100).toFixed(digits)}%` : "—");
export const money = (x: number): string => Math.round(x).toLocaleString("en-US");
