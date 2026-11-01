import { useEffect } from "react";
import type { RunDetail, RunSummary } from "../../shared/types.ts";
import { useApi } from "../api.ts";
import { Empty, ErrorLine, Status } from "../components/ui.tsx";
import { ago, runDuration } from "../format.ts";
import { step, useKeys } from "../keys.ts";
import { navigate } from "../router.ts";
import { RunDetailView } from "./RunDetail.tsx";

export function Runs({ param }: { param: string | null }) {
  const list = useApi<RunSummary[]>("/api/runs?limit=200");
  const runs = list.data ?? [];
  const selectedId = param ?? runs[0]?.runId ?? null;
  const detail = useApi<RunDetail>(selectedId ? `/api/runs/${selectedId}` : null);
  const idx = runs.findIndex((r) => r.runId === selectedId);

  useEffect(() => {
    document.querySelector(".split-list [aria-selected='true']")?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);
  useKeys({
    j: () => runs[step(idx, runs.length, 1)] && navigate("runs", runs[step(idx, runs.length, 1)]!.runId),
    ArrowDown: () => runs[step(idx, runs.length, 1)] && navigate("runs", runs[step(idx, runs.length, 1)]!.runId),
    k: () => runs[step(idx, runs.length, -1)] && navigate("runs", runs[step(idx, runs.length, -1)]!.runId),
    ArrowUp: () => runs[step(idx, runs.length, -1)] && navigate("runs", runs[step(idx, runs.length, -1)]!.runId),
  });

  let lastDate = "";
  return (
    <div className="split-view">
      <nav className="split-list" aria-label="runs">
        <div className="list-head"><span>実行 {runs.length}</span><span>j/k</span></div>
        {runs.length === 0 && <div style={{ padding: "0 2ch" }}><Empty>実行はまだありません</Empty></div>}
        {runs.map((r) => {
          const d = r.createdAt.slice(0, 10);
          const head = d !== lastDate ? <div className="list-group">{d}</div> : null;
          lastDate = d;
          return (
            <div key={r.runId}>
              {head}
              <div className="list-item" aria-selected={r.runId === selectedId} onClick={() => navigate("runs", r.runId)}>
                <Status s={r.status} label={false} />
                <span className="ellipsis">{r.workflow}</span>
                <span className="dim">{r.asOf}</span>
                <span className="sub">{ago(r.createdAt)} · {runDuration(r)}</span>
              </div>
            </div>
          );
        })}
      </nav>
      <section className="split-detail">
        <ErrorLine error={detail.error} />
        {detail.data ? <RunDetailView d={detail.data} /> : !detail.error && selectedId && <Empty>読み込み中…</Empty>}
      </section>
    </div>
  );
}
