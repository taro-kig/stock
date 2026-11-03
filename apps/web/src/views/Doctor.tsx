import { useState } from "react";
import type { CheckResult } from "@stockai/core";
import type { WorkflowInfo } from "../../shared/types.ts";
import { post, useApi } from "../api.ts";
import { Pane } from "../components/ui.tsx";
import { time } from "../format.ts";
import { navigate } from "../router.ts";

type Toast = (m: string, err?: boolean) => void;

const MARK: Record<CheckResult["status"], { m: string; cls: string }> = {
  ok: { m: "✓", cls: "ok" }, warn: { m: "⚠", cls: "warn" }, fail: { m: "✕", cls: "fail" }, skip: { m: "–", cls: "faint" },
};
const GROUP: Record<CheckResult["group"], string> = { config: "設定", llm: "LLM", data: "データ", notify: "通知", broker: "証券会社", storage: "保存" };

/** One small real request per service; then an optional trial run of a workflow for today. */
export function DoctorPane({ toast }: { toast: Toast }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ at: string; results: CheckResult[] } | null>(null);
  const wfs = useApi<WorkflowInfo[]>("/api/workflows");
  const runnable = (wfs.data ?? []).filter((w) => !w.problems.length && !w.disabled && !w.marketMismatch);
  const [wf, setWf] = useState("");
  // the cheap rules baseline of whichever market the settings are for
  const trial = wf || runnable.find((w) => w.name === "daily-rules" || w.name === "daily-jp-rules")?.name || runnable.find((w) => w.market)?.name || runnable[0]?.name || "";

  async function check() {
    setBusy(true);
    try {
      setRes(await post<{ at: string; results: CheckResult[] }>("/api/doctor", {}));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    try {
      const r = await post<{ runId: string }>(`/api/workflows/${trial}/run`, {});
      toast(`${trial} を今日の分で実行します（ノードごとの結果を表示）`);
      navigate("runs", r.runId);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  const fails = res?.results.filter((r) => r.status === "fail").length ?? 0;
  const warns = res?.results.filter((r) => r.status === "warn").length ?? 0;
  return (
    <Pane title="接続チェック" aux={res ? `${time(res.at)} · ✕ ${fails} · ⚠ ${warns}` : "まだ実行していない"} className={fails ? "alert" : ""}>
      <p className="dim">
        各サービスに小さな問い合わせを1回ずつ送り、キー・接続・応答の形を確かめます（LLM はモデルごとに短い1回、Twelve Data は 1 クレジット、Alpha Vantage はその日の決算予定の取得を兼ねる、Discord は投稿しない確認だけ）。
      </p>
      <div className="btn-row" style={{ marginBottom: 6 }}>
        <button className="btn primary" disabled={busy} onClick={() => void check()}>{busy ? "確認中…（30秒ほど）" : "全部チェック"}</button>
        <span className="faint">次に試運転:</span>
        <select className="input" value={trial} onChange={(e) => setWf(e.target.value)} aria-label="trial workflow">
          {runnable.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
        </select>
        <button className="btn" disabled={!trial} onClick={() => void run()}>今日の分で実行</button>
      </div>
      {res && (
        <table className="t doctor">
          <tbody>
            {res.results.map((r) => (
              <tr key={r.id}>
                <td className={`nowrap ${MARK[r.status].cls}`} style={{ width: "2ch" }}>{MARK[r.status].m}</td>
                <td className="nowrap"><span className="faint">{GROUP[r.group]} · </span>{r.label}</td>
                <td>
                  <div className={r.status === "fail" ? "fail" : "fg2"}>{r.detail}</div>
                  {r.hint && r.status !== "ok" && <div className="faint">→ {r.hint}</div>}
                </td>
                <td className="num faint nowrap">{r.ms ? `${r.ms} ms` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {res && !fails && <p className="ok">必須の項目はすべて OK。試運転で、ノードごとに実データが流れるか確かめてください。</p>}
    </Pane>
  );
}
