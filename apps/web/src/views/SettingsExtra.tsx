import { useEffect, useMemo, useState } from "react";
import type { BackupStatus } from "@stockai/core";
import type { WatchlistView } from "../../shared/types.ts";
import { post, put, useApi } from "../api.ts";
import { Empty, ErrorLine, Kbd, Pane } from "../components/ui.tsx";
import { time } from "../format.ts";
import { SuggestBox, type NewRow } from "./SuggestBox.tsx";

type Toast = (m: string, err?: boolean) => void;

interface Row {
  key: number;
  ticker: string;
  name: string;
  aliases: string;
  sector: string;
  isNew: boolean;
}

let nextKey = 1;
const toRows = (w: WatchlistView["watchlist"]): Row[] =>
  Object.entries(w)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ticker, e]) => ({ key: nextKey++, ticker, name: e.name, aliases: e.aliases.join(", "), sector: e.sector, isNew: false }));
const fingerprint = (rows: Row[], benchmark: string) =>
  JSON.stringify([benchmark.trim(), rows.map((r) => [r.ticker.trim(), r.name.trim(), r.aliases.split(",").map((a) => a.trim()).filter(Boolean), r.sector.trim()])]);

export function WatchlistPane({ toast }: { toast: Toast }) {
  const { data, error, reload } = useApi<WatchlistView>("/api/config/watchlist");
  const [rows, setRows] = useState<Row[]>([]);
  const [benchmark, setBenchmark] = useState("");
  /** Fingerprint of what was loaded; null until the server answered (nothing is editable before). */
  const [base, setBase] = useState<string | null>(null);
  /** Tickers the edit started from: the server refuses the save if the file changed meanwhile. */
  const [previous, setPrevious] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const dirty = base !== null && fingerprint(rows, benchmark) !== base;

  const load = (v: WatchlistView) => {
    const r = toRows(v.watchlist);
    setRows(r);
    setBenchmark(v.benchmark);
    setBase(fingerprint(r, v.benchmark));
    setPrevious(Object.keys(v.watchlist).sort());
  };

  useEffect(() => {
    if (!data || dirty) return; // never clobber edits in progress
    load(data);
  }, [data]);

  const sectors = useMemo(() => [...new Set(rows.map((r) => r.sector.trim()).filter(Boolean))].sort(), [rows]);
  const dupes = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.ticker.trim(), (seen.get(r.ticker.trim()) ?? 0) + 1);
    return new Set([...seen].filter(([t, n]) => t && n > 1).map(([t]) => t));
  }, [rows]);
  const invalid = rows.some((r) => !/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(r.ticker.trim()) || !r.name.trim()) || dupes.size > 0;

  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true);
    try {
      const watchlist = Object.fromEntries(
        rows.map((r) => [r.ticker.trim(), { name: r.name.trim(), aliases: r.aliases.split(",").map((a) => a.trim()).filter(Boolean), sector: r.sector.trim() || "unknown" }]),
      );
      const res = await put<{ file: string; created: boolean; tickers: number }>("/api/config/watchlist", { watchlist, benchmark, previous });
      setBase(fingerprint(rows, benchmark));
      setPrevious(Object.keys(watchlist).sort());
      setRows((rs) => rs.map((r) => ({ ...r, isNew: false })));
      toast(`${res.tickers} 銘柄を ${res.file} に保存しました${res.created ? "（新規作成）" : ""}。次の実行から使われます`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorLine error={error} />;
  if (!data || base === null) return null;
  return (
    <Pane title="ウォッチリスト" aux={`${rows.length} 銘柄${dirty ? " · 未保存" : ""}`} className={dirty ? "focus" : ""}>
      <p className="dim">
        保存先 <code>{data.file ?? "—"}</code>
        {data.loadedFrom && data.file !== data.loadedFrom && <>（初回の保存で <code>{data.loadedFrom}</code> から作成）</>}。コメントや他の設定はそのまま残り、直前の版は <Kbd>.bak</Kbd> に残ります。
        名前と別名はニュースの本文と単語単位で照合します。追加した銘柄の価格は次の実行で取得します。
      </p>
      <table className="t watchlist">
        <thead><tr><th style={{ width: "12ch" }}>ティッカー</th><th>名前</th><th>別名（カンマ区切り）</th><th style={{ width: "21ch" }}>セクター</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                {r.isNew ? (
                  <input className={`input ${dupes.has(r.ticker.trim()) ? "bad" : ""}`} value={r.ticker} placeholder="AAPL" onChange={(e) => set(r.key, { ticker: e.target.value.toUpperCase() })} aria-label="ticker" />
                ) : (
                  <b>{r.ticker}</b>
                )}
              </td>
              <td><input className="input" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} aria-label={`${r.ticker} name`} /></td>
              <td><input className="input" value={r.aliases} onChange={(e) => set(r.key, { aliases: e.target.value })} aria-label={`${r.ticker} aliases`} /></td>
              <td><input className="input" list="sectors" value={r.sector} onChange={(e) => set(r.key, { sector: e.target.value })} aria-label={`${r.ticker} sector`} /></td>
              <td><button className="btn icon" type="button" title="この銘柄を外す" aria-label={`${r.ticker} を外す`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="sectors">{sectors.map((x) => <option key={x} value={x} />)}</datalist>
      {rows.length === 0 && <Empty>銘柄がありません</Empty>}
      <div className="btn-row" style={{ marginTop: "calc(var(--lh) * 0.5)" }}>
        <button className="btn" type="button" onClick={() => setRows((rs) => [...rs, { key: nextKey++, ticker: "", name: "", aliases: "", sector: "", isNew: true }])}>＋ 銘柄を追加</button>
        <label className="dim">ベンチマーク <input className="input" style={{ width: "10ch" }} value={benchmark} onChange={(e) => setBenchmark(e.target.value.toUpperCase())} aria-label="benchmark" /></label>
        <span className="spacer" style={{ flex: 1 }} />
        {dirty && <button className="btn" type="button" onClick={() => load(data)}>元に戻す</button>}
        <button className="btn primary" type="button" disabled={!dirty || invalid || busy || rows.length === 0} onClick={() => void save()}>保存</button>
      </div>
      {data.currency === "USD" && (
        <SuggestBox
          toast={toast}
          onAdd={(add: NewRow[]) =>
            setRows((rs) => {
              const have = new Set(rs.map((r) => r.ticker.trim()));
              return [...rs, ...add.filter((a) => !have.has(a.ticker)).map((a) => ({ key: nextKey++, ...a, isNew: true }))];
            })
          }
        />
      )}
      {invalid && dirty && <p className="warn">ティッカー（英大文字・数字・. -、10 文字まで）と名前は必須。重複は不可{dupes.size ? `: ${[...dupes].join(", ")}` : ""}</p>}
    </Pane>
  );
}

const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);

export function BackupPane({ toast }: { toast: Toast }) {
  const { data, error, reload } = useApi<BackupStatus>("/api/backup");
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorLine error={error} />;
  if (!data) return null;
  return (
    <Pane title="バックアップ" aux={data.enabled ? `毎日 ${data.at}` : "無効"} className={data.enabled && !data.last ? "alert" : ""}>
      <dl className="kv">
        <dt>保存先</dt><dd><code>{data.dir}</code></dd>
        <dt>最新</dt><dd>{data.last ? <>{time(data.last.at)} <span className="dim">{data.last.name} · {size(data.last.size)}</span></> : <span className="warn">まだありません</span>}</dd>
        <dt>保持</dt><dd>{data.count} 件 <span className="dim">（直近 {data.keepDaily} 日分 + 月ごとに {data.keepMonthly} か月分）</span></dd>
        <dt>API キー</dt><dd className="dim">{data.includeSettings ? "settings.sqlite もコピーする（平文。保存先の扱いに注意）" : "含めない（キーは設定画面で入れ直せる）"}</dd>
      </dl>
      <div className="btn-row" style={{ marginTop: "calc(var(--lh) * 0.5)" }}>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ file: { name: string } }>("/api/backup", {});
              toast(`バックアップしました: ${r.file.name}`);
              reload();
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), true);
            } finally {
              setBusy(false);
            }
          }}
        >
          今すぐバックアップ
        </button>
        <span className="faint">サーバーの起動中に毎日 {data.at} 以降に1回。保存先・時刻・保持数は config.yaml の backup で変えられます</span>
      </div>
      <p className="faint">戻すとき: サーバーを止め、バックアップを <code>data/stockai.sqlite</code> にコピー（<code>-wal</code> / <code>-shm</code> は削除）してから起動。別のディスクや同期フォルダを <code>backup.dir</code> にすると、PC の故障にも備えられます。</p>
    </Pane>
  );
}
