import type { WatchlistView } from "../../shared/types.ts";
import { useApi } from "../api.ts";
import { Empty, Pane } from "../components/ui.tsx";
import { time } from "../format.ts";
import { WatchlistPane } from "./SettingsExtra.tsx";

type Toast = (m: string, err?: boolean) => void;

const SOURCE: Record<string, string> = { ui: "画面", mcp: "Claude", review: "定期見直し" };

/** The universe the system watches and may buy: edit it, let the AI propose stocks, see what changed. */
export function Watchlist({ toast }: { toast: Toast }) {
  const { data } = useApi<WatchlistView>("/api/config/watchlist");
  return (
    <div className="watchlist-layout">
      <div className="settings" style={{ maxWidth: "none" }}>
        <WatchlistPane toast={toast} />
      </div>
      <div className="stack">
        {data && data.heldNotWatched.length > 0 && (
          <Pane title="保有中・対象外" aux={`${data.heldNotWatched.length}`}>
            <p className="dim">ウォッチリストから外したが、まだ保有している銘柄。新しく買うことはないが、損切り・評価・売却の管理は続く。</p>
            <div>{data.heldNotWatched.map((t) => <span key={t} className="cal-earn held">{t}</span>)}</div>
          </Pane>
        )}
        <Pane title="変更の記録" aux={data ? `${data.history.length}` : ""}>
          {!data || data.history.length === 0 ? <Empty>まだ変更はありません</Empty> : (
            <table className="t">
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.id}>
                    <td className="dim nowrap" style={{ verticalAlign: "top" }}>{time(h.at)}<div className="faint">{SOURCE[h.source] ?? h.source}</div></td>
                    <td>
                      {h.added.map((a) => <div key={`+${a.ticker}`}><b className="up">+ {a.ticker}</b> <span className="dim">{a.name}</span>{a.reason && <div className="faint">{a.reason}</div>}</div>)}
                      {h.removed.map((r) => <div key={`-${r.ticker}`}><b className="down">− {r.ticker}</b>{r.reason && <span className="faint"> {r.reason}</span>}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="faint">月1回の自動見直しはワークフロー <code>universe-review</code>（追加・削除の候補が「承認」に出ます）。Claude との会話でも追加できます（MCP の「銘柄を探す」）。</p>
        </Pane>
      </div>
    </div>
  );
}
