import { Fragment, useState } from "react";
import type { SettingStatus } from "@stockai/core";
import type { SettingsView } from "../../shared/types.ts";
import { del, post, put, useApi } from "../api.ts";
import { BackupPane } from "./SettingsExtra.tsx";
import { DoctorPane } from "./Doctor.tsx";
import { ModelsPane } from "./Models.tsx";
import { Empty, ErrorLine, Pane } from "../components/ui.tsx";
import { time } from "../format.ts";

type Toast = (m: string, err?: boolean) => void;

const GROUPS: Array<[SettingStatus["group"], string]> = [
  ["llm", "LLM"],
  ["data", "データ"],
  ["notify", "通知"],
  ["broker", "証券会社"],
  ["other", "その他（config.yaml が参照）"],
];

const SOURCE: Record<string, { text: string; cls: string; title: string }> = {
  settings: { text: "設定画面", cls: "ok", title: "この画面で保存した値（settings.sqlite）" },
  dotenv: { text: ".env", cls: "st-cached", title: ".env から読み込んだ値。ここで保存するとこちらが優先されます" },
  shell: { text: "shell", cls: "warn", title: "シェルで export された値。最優先のため、この画面からは変更できません" },
};

function Row({ item, onSaved, toast }: { item: SettingStatus; onSaved: () => void; toast: Toast }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const locked = item.source === "shell";
  const src = item.source ? SOURCE[item.source] : undefined;

  const save = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      await put(`/api/settings/${item.name}`, { value });
      setValue("");
      toast(`${item.label} を保存しました`);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!confirmClear) return setConfirmClear(true);
    setConfirmClear(false);
    setBusy(true);
    try {
      await del(`/api/settings/${item.name}`);
      toast(`${item.label} を削除しました`);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setting">
      <div className="setting-head">
        <span className={item.set ? "ok" : "faint"}>{item.set ? "●" : "○"}</span>
        <b>{item.label}</b>
        <code className="faint">{item.name}</code>
        {item.usedByConfig && <span className="badge" title="config.yaml のモデル・証券設定が参照しています">使用中</span>}
        <span className="spacer" />
        {src ? <span className={src.cls} title={src.title}>{src.text}</span> : <span className="faint">未設定</span>}
      </div>
      <div className="setting-help dim">
        {item.help}
        {item.url && <> · <a href={item.url} target="_blank" rel="noreferrer noopener">取得先 ↗</a></>}
      </div>
      <div className="setting-current">
        <span className="dim">現在: </span>
        {item.set ? <span className="fg2">{item.preview}</span> : <span className="faint">—</span>}
        {item.updatedAt && <span className="faint">  （保存 {time(item.updatedAt)}）</span>}
      </div>
      {locked ? (
        <div className="faint">シェルの環境変数が優先されています。変更するにはシェルで unset してからサーバーを再起動してください。</div>
      ) : (
        <form
          className="btn-row"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="input setting-input"
            type={item.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={item.set ? "新しい値で上書き" : item.secret ? "キーを貼り付け" : "stockai you@example.com"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={item.label}
          />
          <button className="btn primary" type="submit" disabled={busy || !value.trim()}>保存</button>
          {item.name === "DISCORD_WEBHOOK_URL" && item.set && (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await post("/api/notify/test", {});
                  toast("Discord にテスト通知を送りました");
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e), true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              テスト送信
            </button>
          )}
          {item.source === "settings" && (
            <button className="btn danger" type="button" disabled={busy} onClick={() => void clear()} onBlur={() => setConfirmClear(false)}>
              {confirmClear ? "もう一度押して削除" : "削除"}
            </button>
          )}
        </form>
      )}
    </div>
  );
}

export function Settings({ toast }: { toast: Toast }) {
  const { data, error, reload } = useApi<SettingsView>("/api/settings");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <Empty>読み込み中</Empty>;
  if (!data.available) return <Pane title="設定"><Empty>このサーバーでは設定画面を使えません</Empty></Pane>;
  // Broker keys are only needed by the broker workflows; don't nag about them.
  const missing = data.items.filter((i) => i.usedByConfig && !i.set && i.group !== "broker");
  return (
    <div className="settings">
      <Pane title="API キー・接続設定" aux={data.path ?? ""} className={missing.length ? "alert" : ""}>
        <p className="fg2">
          ここで保存した値はサーバーの <code>{data.path}</code>（SQLite・権限 600）に保存され、<b>再起動なしで</b>次の実行から使われます。
          CLI（<code>npm run stockai</code>）も同じファイルを読みます。
        </p>
        <p className="dim">
          優先順位: シェルの環境変数 &gt; この画面 &gt; <code>.env</code>。保存したキーは画面に表示されません（末尾4文字のみ）。
          ファイルは暗号化されていない平文なので、data ディレクトリを共有・コミットしないこと。本番発注のスイッチ（STOCKAI_LIVE_TRADING）はここでは設定できません。
        </p>
        {missing.length > 0 && <p className="warn">config.yaml が使うのに未設定: {missing.map((m) => m.name).join(", ")}</p>}
      </Pane>
      <DoctorPane toast={toast} />
      {GROUPS.map(([g, title]) => {
        const items = data.items.filter((i) => i.group === g);
        if (!items.length) return null;
        return (
          <Fragment key={g}>
            <Pane title={title} aux={`${items.filter((i) => i.set).length}/${items.length} 設定済み`}>
              <div className="setting-list">
                {items.map((i) => <Row key={i.name} item={i} onSaved={reload} toast={toast} />)}
              </div>
            </Pane>
            {g === "llm" && <ModelsPane toast={toast} />}
          </Fragment>
        );
      })}
      <BackupPane toast={toast} />
    </div>
  );
}
