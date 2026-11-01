import { useCallback, useEffect, useState } from "react";
import type { Overview as OverviewData, StreamEvent } from "../shared/types.ts";
import { PulseContext, useApi, useStream } from "./api.ts";
import { time, until, usd } from "./format.ts";
import { useKeys } from "./keys.ts";
import { Editor } from "./editor/Editor.tsx";
import { navigate, TABS, useRoute, type View } from "./router.ts";
import { Approvals } from "./views/Approvals.tsx";
import { Help } from "./views/Help.tsx";
import { Nodes } from "./views/Nodes.tsx";
import { Overview } from "./views/Overview.tsx";
import { Runs } from "./views/Runs.tsx";
import { Scorecard } from "./views/Scorecard.tsx";
import { Settings } from "./views/Settings.tsx";
import { Workflows } from "./views/Workflows.tsx";

const LABELS: Record<View, string> = { overview: "概要", runs: "実行", approvals: "承認", scorecard: "確度", workflows: "フロー", nodes: "ノード", settings: "設定", editor: "編集" };

interface Toast {
  id: number;
  text: string;
  err: boolean;
}

function usePref(key: string, attr: string, values: [string, string]): () => void {
  const [v, setV] = useState(() => localStorage.getItem(key) ?? values[0]);
  useEffect(() => {
    document.documentElement.setAttribute(attr, v);
    localStorage.setItem(key, v);
  }, [v, key, attr]);
  return () => setV((x) => (x === values[0] ? values[1] : values[0]));
}

function Shell({ connected, lastEvent }: { connected: boolean; lastEvent: string }) {
  const route = useRoute();
  const ov = useApi<OverviewData>("/api/overview");
  const [help, setHelp] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(() => new Date());
  const toggleTheme = usePref("stockai.theme", "data-theme", ["ink", "paper"]);
  const toggleUpDown = usePref("stockai.updown", "data-updown", ["jp", "us"]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const toast = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, err }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), err ? 7000 : 3500);
  }, []);

  useKeys({
    ...Object.fromEntries(TABS.map((v, i) => [String(i + 1), () => navigate(v)])),
    "?": () => setHelp((h) => !h),
    Escape: () => setHelp(false),
    t: toggleTheme,
    u: toggleUpDown,
  });

  const data = ov.data;
  const pending = data?.pending.reduce((n, p) => n + p.gates.length, 0) ?? 0;
  const next = data?.schedule.filter((s) => s.nextAt).sort((a, b) => (a.nextAt! < b.nextAt! ? -1 : 1))[0];
  const busy = data?.queue.running;
  const split = route.view === "runs" || route.view === "workflows" || route.view === "nodes" || route.view === "editor";

  useEffect(() => {
    document.title = pending ? `(${pending}) stockai` : "stockai";
  }, [pending]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">▁▃▆</span>stockai</div>
        <nav className="tabs">
          {TABS.map((v, i) => (
            <a key={v} className="tab" href={`#/${v}`} aria-current={route.view === v || (v === "workflows" && route.view === "editor") ? "page" : undefined}>
              <span className="key">{i + 1}</span>
              {LABELS[v]}
              {v === "approvals" && pending > 0 && <span className="count">{pending}</span>}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          {data?.fake && <span className="badge fake" title="疑似モデル (--fake)。API キー不要・成績に意味はありません">FAKE</span>}
          <span className={connected ? "ok" : "fail"} title={connected ? "サーバーと接続中" : "切断（再接続中）"}>{connected ? "●" : "○"}</span>
          <span className="clock">{now.toLocaleDateString("sv-SE")} {now.toLocaleTimeString("ja-JP")}</span>
        </div>
      </header>

      <main className={`main ${split ? "split" : ""}`}>
        {route.view === "overview" && <Overview data={data} />}
        {route.view === "runs" && <Runs param={route.param} />}
        {route.view === "approvals" && <Approvals overview={data} param={route.param} toast={toast} />}
        {route.view === "scorecard" && <Scorecard card={data?.scorecard} />}
        {route.view === "workflows" && <Workflows param={route.param} toast={toast} />}
        {route.view === "nodes" && <Nodes param={route.param} />}
        {route.view === "settings" && <Settings toast={toast} />}
        {route.view === "editor" && <Editor key={route.param ?? "new"} name={route.param} toast={toast} />}
      </main>

      <footer className="statusline">
        <span className={`mode ${busy ? "busy" : ""}`}>{busy ? "RUN" : "IDLE"}</span>
        <span>{busy ? <>▶ {busy}{data && data.queue.pending > 0 ? ` +${data.queue.pending}` : ""}</> : "キュー空"}</span>
        <span>LLM {usd(data?.cost.spentToday)} <span className="faint">/ {usd(data?.cost.dailyLimit, 2)}</span></span>
        <span>{next ? <>次回 {time(next.nextAt)} {next.workflow} <span className="faint">({until(next.nextAt, now.getTime())})</span></> : <span className="faint">スケジュールなし</span>}</span>
        {lastEvent && <span className="faint ellipsis" style={{ maxWidth: "48ch" }}>{lastEvent}</span>}
        <span className="spacer" />
        <span><kbd>?</kbd> ヘルプ  <kbd>t</kbd> テーマ</span>
      </footer>

      {help && <Help onClose={() => setHelp(false)} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.err ? "err" : ""}`}>{t.err ? "✕ " : "✓ "}{t.text}</div>)}
      </div>
    </div>
  );
}

export function App() {
  const [lastEvent, setLastEvent] = useState("");
  const { connected, pulse } = useStream((e: StreamEvent) => {
    if (e.type === "queued") setLastEvent(`queued ${e.workflow}`);
    if (e.type === "run_event") {
      const ev = e.event as { type?: string; node?: string; status?: string };
      setLastEvent(ev.type === "node_finished" ? `${ev.node} ${ev.status}` : `${ev.type ?? ""} ${ev.status ?? ""}`.trim());
    }
  });
  return (
    <PulseContext.Provider value={pulse}>
      <Shell connected={connected} lastEvent={lastEvent} />
    </PulseContext.Provider>
  );
}
