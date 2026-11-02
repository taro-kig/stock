import { sendDiscord, type Notice, type NotifyEvent, type NodeRegistry, type Services } from "@stockai/core";
import type { RunDetail } from "../shared/types.ts";
import { runDetail } from "./views.ts";

/**
 * Turns finished runs into Discord notices. Each (run, event) is sent at most once, so a
 * run that is resumed while still waiting (approval timeouts) does not notify again.
 * Sending never throws: a broken webhook must not break runs.
 */
export class RunNotifier {
  readonly #s: Services;
  readonly #registry: NodeRegistry;
  readonly #clock: () => Date;

  constructor(s: Services, registry: NodeRegistry, clock: () => Date = () => new Date()) {
    this.#s = s;
    this.#registry = registry;
    this.#clock = clock;
    s.db.exec("CREATE TABLE IF NOT EXISTS notify_log (run_id TEXT, kind TEXT, sent_at TEXT, error TEXT, PRIMARY KEY (run_id, kind))");
  }

  get webhook(): string | undefined {
    return this.#s.env[this.#s.config.notify.webhookEnv] || undefined;
  }

  #wants(e: NotifyEvent): boolean {
    return this.#s.config.notify.events.includes(e);
  }

  #link(path: string): string | undefined {
    const base = this.#s.config.notify.baseUrl.replace(/\/+$/, "");
    return /^https?:\/\//.test(base) ? `${base}/#/${path}` : undefined;
  }

  /** Sends now, regardless of the event filter (used by the "test" button). Throws on failure. */
  async send(n: Notice): Promise<void> {
    const url = this.webhook;
    if (!url) throw new Error(`${this.#s.config.notify.webhookEnv} が未設定です（設定画面で入力）`);
    await sendDiscord(url, { timestamp: this.#clock().toISOString(), ...n }, { fetchImpl: this.#s.fetch, sleep: this.#s.sleep });
  }

  async #once(runId: string, kind: string, n: Notice): Promise<boolean> {
    if (!this.webhook) return false;
    const db = this.#s.db;
    const seen = db.prepare("SELECT 1 FROM notify_log WHERE run_id = ? AND kind = ? AND error IS NULL").get(runId, kind);
    if (seen) return false;
    let error: string | null = null;
    try {
      await this.send(n);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error(`notify ${kind} ${runId}: ${error}`);
    }
    db.prepare("INSERT OR REPLACE INTO notify_log VALUES (?,?,?,?)").run(runId, kind, this.#clock().toISOString(), error);
    return error === null;
  }

  /** Call after a run (or resume) settles. Returns the kinds that were sent. */
  async runSettled(runId: string): Promise<string[]> {
    if (!this.webhook) return [];
    const run = this.#s.runStore.getRun(runId);
    if (!run) return [];
    let d: RunDetail;
    try {
      d = runDetail(this.#s, this.#registry, run);
    } catch (e) {
      console.error(`notify: cannot read run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    const sent: string[] = [];
    const head = `${run.workflow} · ${run.asOf}`;
    const money = (x: number) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));

    const changes = d.waiting.find((g) => g.changes)?.changes;
    if (run.status === "waiting" && changes && this.#wants("approval")) {
      const n: Notice = {
        title: `🗂 ウォッチリストの見直し: 追加 ${changes.add.length} / 削除 ${changes.remove.length}`,
        description: "Web 画面の「2 承認」で承認・却下してください。",
        tone: "warn",
        fields: [
          ...changes.add.slice(0, 12).map((a) => ({ name: `+ ${a.ticker} ${a.name} (${a.sector})`, value: a.reason || "—" })),
          ...changes.remove.slice(0, 8).map((r) => ({ name: `− ${r.ticker} ${r.name}${r.held ? "（保有中）" : ""}`, value: r.reasons.join("\n") || "—" })),
        ],
      };
      const url = this.#link(`approvals/${runId}`);
      if (url) n.url = url;
      if (await this.#once(runId, "approval", n)) sent.push("approval");
    } else if (run.status === "waiting" && this.#wants("approval")) {
      const orders = d.waiting.flatMap((g) => g.proposals);
      const broken = d.nodes.filter((x) => x.status === "failed" || x.status === "fallback").map((x) => x.id);
      const n: Notice = {
        title: `⏳ 承認待ち: ${head}`,
        description:
          (orders.length ? `注文 ${orders.length} 件。Web 画面の「2 承認」で承認・却下してください。` : "承認待ちです（注文なし）。") +
          (broken.length ? `\n※ 問題のあったノード: ${broken.join(", ")}` : ""),
        tone: "warn",
        fields: orders.slice(0, 20).map((p) => ({
          name: `${p.action === "buy" ? "BUY" : "SELL"} ${p.ticker} ${d.names[p.ticker] ?? ""}`.trim(),
          value: `${p.shares} 株 @ ${money(p.price)}\n${p.reason}`,
        })),
      };
      const url = this.#link(`approvals/${runId}`);
      if (url) n.url = url;
      if (await this.#once(runId, "approval", n)) sent.push("approval");
    }

    if ((run.status === "failed" || run.status === "partial") && this.#wants("failure")) {
      const bad = d.nodes.filter((x) => x.status === "failed" || x.status === "fallback" || (x.status === "skipped" && x.error));
      const n: Notice = {
        title: `${run.status === "failed" ? "✕ 失敗" : "◐ 一部失敗"}: ${head}`,
        description: bad.length ? `${bad.length} ノードに問題があります。` : "",
        tone: run.status === "failed" ? "fail" : "warn",
        fields: bad.slice(0, 10).map((x) => ({ name: `${x.id} (${x.type}) · ${x.status}`, value: x.error ?? "—" })),
      };
      const url = this.#link(`runs/${runId}`);
      if (url) n.url = url;
      if (await this.#once(runId, `failure:${run.status}`, n)) sent.push("failure");
    }

    const orders = d.highlights.orders ?? [];
    if (orders.length && this.#wants("orders")) {
      const label: Record<string, string> = { submitted: "発注", dry_run: "プレビューのみ", duplicate: "重複のため送らず", blocked: "ガードで停止", error: "エラー" };
      const n: Notice = {
        title: `📨 ブローカー注文 ${orders.length} 件: ${head}`,
        tone: orders.some((o) => o.status === "error" || o.status === "blocked") ? "warn" : "info",
        fields: orders.slice(0, 20).map((o) => ({
          name: `${o.side === "buy" ? "BUY" : "SELL"} ${o.ticker} · ${label[o.status] ?? o.status}`,
          value: `${o.shares} 株 指値 ${money(o.limitPrice)}${o.message ? `\n${o.message}` : ""}`,
        })),
      };
      const url = this.#link(`runs/${runId}`);
      if (url) n.url = url;
      if (await this.#once(runId, "orders", n)) sent.push("orders");
    }

    const fills = d.highlights.fills ?? [];
    if (fills.length && this.#wants("fills")) {
      const n: Notice = {
        title: `✓ ペーパー約定 ${fills.length} 件: ${head}`,
        tone: "ok",
        fields: fills.slice(0, 20).map((f) => ({ name: `${f.side === "buy" ? "BUY" : "SELL"} ${f.ticker}`, value: `${f.shares} 株 @ ${money(f.price)}`, inline: true })),
      };
      if (await this.#once(runId, "fills", n)) sent.push("fills");
    }

    if (run.status === "succeeded" && this.#wants("success")) {
      const j = d.highlights.judgments?.items ?? [];
      const n: Notice = { title: `● 完了: ${head}`, tone: "ok", description: j.length ? `判断 ${j.length} 件` : "" };
      if (await this.#once(runId, "success", n)) sent.push("success");
    }
    return sent;
  }

  /** Backup failures (no run id). */
  async backupFailed(message: string): Promise<void> {
    if (!this.webhook || !this.#wants("backup")) return;
    try {
      await this.send({ title: "✕ バックアップ失敗", description: message, tone: "fail" });
    } catch (e) {
      console.error(`notify backup: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
