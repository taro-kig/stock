import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { NodeDescription } from "@stockai/core";
import type { PromptsView, StreamEvent } from "../../shared/types.ts";
import { get, onStream, post, put, useApi } from "../api.ts";
import { CATEGORY_HUE } from "../components/Dag.tsx";
import { PortType } from "../components/ui.tsx";
import { GLYPH } from "../format.ts";
import { navigate } from "../router.ts";
import * as M from "./model.ts";
import { ParamsForm, type Choices } from "./ParamsForm.tsx";

/** Prompt-version params become dropdowns of the versions that exist. */
function promptChoices(use: string, prompts: PromptsView | undefined): Choices | undefined {
  if (!prompts) return undefined;
  const fam = (f: string) => {
    const v = prompts.families.find((x) => x.family === f);
    return v ? { options: v.versions.map((x) => x.version), defaultLabel: `既定（config: ${v.active}）` } : undefined;
  };
  const out: Choices = {};
  const set = (k: string, f: string) => {
    const c = fam(f);
    if (c) out[k] = c;
  };
  if (use === "llm.extractEvents" || use === "signal.eventHistory") set("promptVersion", "event");
  if (use === "decide.ai") {
    set("promptVersion", "judge");
    set("redTeamVersion", "redteam");
  }
  if (use === "universe.review") set("promptVersion", "universe");
  return Object.keys(out).length ? out : undefined;
}

type Sel = { kind: "node"; id: string } | { kind: "edge"; to: M.PortRef } | null;
interface ViewBox {
  x: number;
  y: number;
  k: number;
}
type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "move"; id: string; dx: number; dy: number; moved: boolean }
  | { kind: "wire"; from: M.PortRef; x: number; y: number };

const CATEGORY_JA: Record<string, string> = {
  source: "情報源", filter: "フィルタ", llm: "LLM", data: "データ", signal: "シグナル",
  decision: "判断", risk: "リスク", gate: "承認", execution: "執行", eval: "評価", universe: "銘柄",
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
const isMac = navigator.platform.toLowerCase().includes("mac");
const MOD = isMac ? "⌘" : "Ctrl+";

/** Problem strings from the server look like "node: …" or "node.params.x: …". */
function problemNode(p: string, spec: M.Spec): string | null {
  const id = /^([A-Za-z][A-Za-z0-9_]*)[.:]/.exec(p)?.[1];
  return id && spec.nodes[id] ? id : null;
}

export function Editor({ name, toast }: { name: string | null; toast: (m: string, err?: boolean) => void }) {
  const catalogQ = useApi<NodeDescription[]>("/api/nodes");
  const promptsQ = useApi<PromptsView>("/api/prompts");
  const catalog: M.Catalog = useMemo(() => new Map((catalogQ.data ?? []).map((d) => [d.type, d])), [catalogQ.data]);
  const isNew = name === null;

  // ── document + history ────────────────────────────────────────────────
  const [hist, setHist] = useState<{ stack: M.Spec[]; i: number } | null>(null);
  const [savedJson, setSavedJson] = useState<string>("");
  const [loadError, setLoadError] = useState<string>();
  const spec = hist ? hist.stack[hist.i]! : null;
  const dirty = spec !== null && JSON.stringify(spec) !== savedJson;

  useEffect(() => {
    if (!catalogQ.data) return;
    if (isNew) {
      const s = M.blankSpec("new-workflow");
      setHist({ stack: [s], i: 0 });
      setSavedJson("");
      return;
    }
    get<{ spec: Parameters<typeof M.normalizeSpec>[0] }>(`/api/workflows/${name}`).then(
      (r) => {
        let s = M.normalizeSpec(r.spec);
        if (Object.values(s.nodes).some((n) => n.ui.x === undefined || n.ui.y === undefined)) s = M.autoLayout(s, catalog);
        setHist({ stack: [s], i: 0 });
        setSavedJson(JSON.stringify(s));
      },
      (e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)),
    );
  }, [name, isNew, catalogQ.data, catalog]);

  const commit = useCallback((next: M.Spec) => {
    setHist((h) => {
      if (!h) return h;
      if (JSON.stringify(h.stack[h.i]) === JSON.stringify(next)) return h;
      const stack = [...h.stack.slice(0, h.i + 1), next].slice(-200);
      return { stack, i: stack.length - 1 };
    });
  }, []);
  const undo = useCallback(() => setHist((h) => (h && h.i > 0 ? { ...h, i: h.i - 1 } : h)), []);
  const redo = useCallback(() => setHist((h) => (h && h.i < h.stack.length - 1 ? { ...h, i: h.i + 1 } : h)), []);

  // ── selection, view, drag ─────────────────────────────────────────────
  const [sel, setSel] = useState<Sel>(null);
  const [view, setView] = useState<ViewBox>({ x: 32, y: 32, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [livePos, setLivePos] = useState<{ id: string; x: number; y: number } | null>(null);
  const livePosRef = useRef(livePos);
  livePosRef.current = livePos;
  const canvasRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const toWorld = useCallback((cx: number, cy: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k };
  }, []);

  const pos = useCallback(
    (id: string) => {
      if (livePos?.id === id) return { x: livePos.x, y: livePos.y };
      const n = spec?.nodes[id];
      return { x: n?.ui.x ?? 0, y: n?.ui.y ?? 0 };
    },
    [spec, livePos],
  );

  // ── validation (local now, server debounced) ─────────────────────────
  const local = useMemo(() => (spec && catalog.size ? M.localProblems(spec, catalog) : {}), [spec, catalog]);
  const [server, setServer] = useState<{ forJson: string; problems: string[] }>({ forJson: "", problems: [] });
  const specJson = spec ? JSON.stringify(spec) : "";
  useEffect(() => {
    if (!spec) return;
    const json = JSON.stringify(spec);
    const t = window.setTimeout(() => {
      post<{ problems: string[] }>("/api/workflows/validate", { spec }).then(
        (r) => setServer({ forJson: json, problems: r.problems }),
        (e: unknown) => setServer({ forJson: json, problems: [e instanceof Error ? e.message : String(e)] }),
      );
    }, 350);
    return () => window.clearTimeout(t);
  }, [spec]);
  /** Server problems once they match the current spec; instant local checks while waiting. */
  const fresh = server.forJson === specJson;
  const serverProblems = fresh ? server.problems : [];
  const badNodes = useMemo(() => {
    const s = new Set(fresh ? [] : Object.keys(local));
    if (spec) for (const p of serverProblems) {
      const id = problemNode(p, spec);
      if (id) s.add(id);
    }
    return s;
  }, [local, serverProblems, spec, fresh]);

  // ── live run status ───────────────────────────────────────────────────
  const [run, setRun] = useState<{ runId: string; status: string; nodes: Record<string, string> } | null>(null);
  useEffect(() => {
    if (!run) return;
    return onStream((e: StreamEvent) => {
      if (e.type !== "run_event" || e.runId !== run.runId) return;
      const ev = e.event as { type?: string; node?: string; status?: string };
      if (ev.type === "node_finished" && ev.node) setRun((r) => (r ? { ...r, nodes: { ...r.nodes, [ev.node!]: ev.status ?? "ok" } } : r));
      if (ev.type === "run_started") setRun((r) => (r ? { ...r, status: "running" } : r));
      if (ev.type === "run_finished") {
        setRun((r) => (r ? { ...r, status: ev.status ?? "succeeded" } : r));
        toast(`実行完了: ${ev.status ?? ""}`, ev.status === "failed");
      }
    });
  }, [run?.runId, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── actions ───────────────────────────────────────────────────────────
  const edges = useMemo(() => (spec && catalog.size ? M.edges(spec, catalog) : []), [spec, catalog]);

  const fit = useCallback((minK = 0.3) => {
    const el = canvasRef.current;
    if (!spec || !el || !Object.keys(spec.nodes).length) return setView({ x: 32, y: 32, k: 1 });
    const boxes = Object.entries(spec.nodes).map(([, n]) => ({ x: n.ui.x ?? 0, y: n.ui.y ?? 0, h: M.nodeHeight(catalog.get(n.use)) }));
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + M.NODE_W));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const pad = 48;
    const fitK = Math.min(1.25, (el.clientWidth - pad * 2) / (maxX - minX), (el.clientHeight - pad * 2) / (maxY - minY));
    const k = Math.max(minK, fitK);
    if (k > fitK) return setView({ k, x: pad - minX * k, y: pad - minY * k }); // too big to fit readably: start at the top-left
    setView({ k, x: (el.clientWidth - (maxX - minX) * k) / 2 - minX * k, y: (el.clientHeight - (maxY - minY) * k) / 2 - minY * k });
  }, [spec, catalog]);
  const fitted = useRef(false);
  useEffect(() => {
    if (spec && catalog.size && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(() => fit(0.6));
    }
  }, [spec, catalog, fit]);

  const addAt = useCallback(
    (type: string, at?: { x: number; y: number }) => {
      if (!spec) return;
      const el = canvasRef.current!;
      const center = at ?? toWorld(el.getBoundingClientRect().left + el.clientWidth / 2, el.getBoundingClientRect().top + el.clientHeight / 2);
      const r = M.addNode(spec, type, { x: center.x - M.NODE_W / 2, y: center.y - 20 });
      commit(r.spec);
      setSel({ kind: "node", id: r.id });
    },
    [spec, commit, toWorld],
  );

  const deleteSelection = useCallback(() => {
    if (!spec || !sel) return;
    if (sel.kind === "node") commit(M.removeNode(spec, sel.id));
    else commit(M.disconnect(spec, sel.to));
    setSel(null);
  }, [spec, sel, commit]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!spec) return false;
    if (!M.NAME_RE.test(spec.name)) {
      toast("名前は英小文字・数字・- _ のみ", true);
      return false;
    }
    try {
      const r = await put<{ file: string; problems: string[] }>(`/api/workflows/${spec.name}`, { spec, ...(isNew ? { create: true } : {}) });
      setSavedJson(JSON.stringify(spec));
      toast(r.problems.length ? `保存しました（問題 ${r.problems.length} 件。直すまで実行できません）` : `保存しました — ${r.file}`, r.problems.length > 0);
      if (isNew) navigate("editor", spec.name);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      return false;
    }
  }, [spec, isNew, toast]);

  const [asOf, setAsOf] = useState("");
  const saveAndRun = useCallback(async () => {
    if (!spec) return;
    if ((dirty || isNew) && !(await save())) return;
    if (serverProblems.length) return toast("問題を直してから実行してください", true);
    try {
      const { runId } = await post<{ runId: string }>(`/api/workflows/${spec.name}/run`, asOf ? { asOf } : {});
      setRun({ runId, status: "queued", nodes: {} });
      toast(`実行をキューに追加しました${asOf ? `（${asOf}）` : ""}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }, [spec, dirty, isNew, save, serverProblems.length, asOf, toast]);

  // ── keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") return e.preventDefault(), void save();
      if (mod && e.key.toLowerCase() === "z") return e.preventDefault(), e.shiftKey ? redo() : undo();
      if (mod && e.key.toLowerCase() === "y") return e.preventDefault(), redo();
      if (mod || e.altKey || typing(e.target)) return;
      if (e.key === "Delete" || e.key === "Backspace") return e.preventDefault(), deleteSelection();
      if (e.key === "Escape") return setSel(null), setDrag(null);
      if (e.key === "f") return fit();
      if (e.key === "l" && spec) return commit(M.autoLayout(spec, catalog)), requestAnimationFrame(() => fit(0.6));
      if (e.key === "/") return e.preventDefault(), searchRef.current?.focus();
      if (e.key === "+" || e.key === "=") return setView((v) => ({ ...v, k: Math.min(2, v.k * 1.15) }));
      if (e.key === "-") return setView((v) => ({ ...v, k: Math.max(0.3, v.k / 1.15) }));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [save, undo, redo, deleteSelection, fit, spec, catalog, commit]);

  // unsaved-changes guard (page unload and in-app navigation)
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    const hash = (e: HashChangeEvent) => {
      if (dirty && !location.hash.startsWith("#/editor") && !confirm("保存していない変更があります。破棄して移動しますか？")) location.hash = new URL(e.oldURL).hash;
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("hashchange", hash);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("hashchange", hash);
    };
  }, [dirty]);

  // wheel: pan, Ctrl/⌘+wheel: zoom at cursor (non-passive listener)
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        setView((v) => {
          const k = Math.max(0.3, Math.min(2, v.k * Math.exp(-e.deltaY * 0.0015)));
          return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
        });
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [hist !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // pointer drags (window-level so they survive leaving the canvas)
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === "pan") setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
      else if (d.kind === "move") {
        const w = toWorld(e.clientX, e.clientY);
        const snap = (n: number) => (e.altKey ? n : Math.round(n / 4) * 4);
        setLivePos({ id: d.id, x: snap(w.x - d.dx), y: snap(w.y - d.dy) });
        if (!d.moved) setDrag({ ...d, moved: true });
      } else {
        const w = toWorld(e.clientX, e.clientY);
        setDrag({ ...d, x: w.x, y: w.y });
      }
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || !spec) return;
      if (d.kind === "move") {
        if (d.moved && livePosRef.current) commit(M.patchNode(spec, d.id, { ui: { x: livePosRef.current.x, y: livePosRef.current.y } }));
        setLivePos(null);
      }
      if (d.kind === "wire") {
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const portEl = el?.closest<HTMLElement>("[data-in-port]");
        let target: M.PortRef | null = portEl ? { node: portEl.dataset["node"]!, port: portEl.dataset["port"]! } : null;
        if (!target) {
          // dropped on a node body: pick its first compatible input, preferring free ones
          const nodeId = el?.closest<HTMLElement>("[data-node]")?.dataset["node"];
          const n = nodeId ? spec.nodes[nodeId] : undefined;
          const inputs = Object.keys((n && catalog.get(n.use)?.inputs) ?? {});
          const ok = inputs.filter((p) => M.canConnect(spec, catalog, d.from, { node: nodeId!, port: p }) === null);
          const pick = ok.find((p) => !n!.in[p]) ?? ok[0];
          target = pick ? { node: nodeId!, port: pick } : null;
          if (nodeId && !pick && nodeId !== d.from.node) toast("つなげる入力がありません（型が合いません）", true);
        }
        if (target) {
          const why = M.canConnect(spec, catalog, d.from, target);
          if (why) toast(why, true);
          else {
            commit(M.connect(spec, d.from, target));
            setSel({ kind: "edge", to: target });
          }
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag !== null, spec, catalog, commit, toWorld, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  // ── render ────────────────────────────────────────────────────────────
  if (loadError) return <div className="split-detail"><div className="callout fail">✕ {loadError}</div></div>;
  if (!spec || !catalog.size) return <div className="split-detail"><div className="empty">読み込み中…</div></div>;

  const portWorld = (id: string, port: string, side: "in" | "out") => {
    const n = spec.nodes[id]!;
    const def = catalog.get(n.use);
    const list = Object.keys((side === "in" ? def?.inputs : def?.outputs) ?? {});
    const p = pos(id);
    return { x: p.x + (side === "out" ? M.NODE_W : 0), y: p.y + M.portY(Math.max(0, list.indexOf(port))) };
  };
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  };
  const wiring = drag?.kind === "wire" ? drag : null;
  const wireType = wiring ? catalog.get(spec.nodes[wiring.from.node]!.use)?.outputs[wiring.from.port]?.type : undefined;
  const selNode = sel?.kind === "node" ? spec.nodes[sel.id] : undefined;
  const selDef = selNode ? catalog.get(selNode.use) : undefined;
  const allProblems = fresh ? serverProblems : Object.entries(local).flatMap(([id, ps]) => ps.map((p) => `${id}: ${p}`));
  const runNodes = run?.nodes ?? {};
  const nodeCount = Object.keys(spec.nodes).length;

  const onCanvasDown = (e: RPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    setSel(null);
    setDrag({ kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
  };

  return (
    <div className="editor">
      {/* ── toolbar ── */}
      <div className="ed-toolbar">
        <button className="btn" onClick={() => navigate("workflows", isNew ? null : spec.name)} title="一覧へ">←</button>
        {isNew ? (
          <input className={`input ed-name ${M.NAME_RE.test(spec.name) ? "" : "bad"}`} value={spec.name} onChange={(e) => commit({ ...spec, name: e.target.value.trim() })} aria-label="ワークフロー名" />
        ) : (
          <span className="ed-title">{spec.name}</span>
        )}
        <span className={dirty ? "warn" : "faint"}>{dirty ? "● 未保存" : "保存済み"}</span>
        <span className={allProblems.length ? "fail" : "ok"}>{allProblems.length ? `✕ 問題 ${allProblems.length}` : "✓ 検証OK"}</span>
        <span className="faint">{nodeCount} nodes · {edges.length} edges</span>
        <span className="ed-spacer" />
        <button className="btn" onClick={undo} disabled={!hist || hist.i === 0} title={`${MOD}Z`}>↶</button>
        <button className="btn" onClick={redo} disabled={!hist || hist.i >= hist.stack.length - 1} title={`${MOD}⇧Z`}>↷</button>
        <button className="btn" onClick={() => (commit(M.autoLayout(spec, catalog)), requestAnimationFrame(() => fit(0.6)))} title="自動整列">整列 <kbd>l</kbd></button>
        <button className="btn" onClick={() => fit()}>全体 <kbd>f</kbd></button>
        <span className="faint nowrap">{Math.round(view.k * 100)}%</span>
        <button className="btn" onClick={() => void save()} disabled={!dirty && !isNew}>保存 <kbd>{MOD}S</kbd></button>
        <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} title="空欄 = 今日" />
        <button className="btn primary" onClick={() => void saveAndRun()}>{dirty || isNew ? "保存して実行" : "実行"}</button>
      </div>

      <div className="ed-body-grid">
        {/* ── palette ── */}
        <Palette catalog={catalogQ.data ?? []} onAdd={(t) => addAt(t)} searchRef={searchRef} />

        {/* ── canvas ── */}
        <div
          ref={canvasRef}
          className={`ed-canvas ${drag?.kind === "pan" ? "panning" : ""} ${wiring ? "wiring" : ""}`}
          style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.k}px ${24 * view.k}px` }}
          onPointerDown={onCanvasDown}
          // the canvas pans via transform; browser scroll-into-view must not shift it
          onScroll={(e) => ((e.currentTarget.scrollLeft = 0), (e.currentTarget.scrollTop = 0))}
          onDragOver={(e) => e.dataTransfer.types.includes("application/x-stockai-node") && e.preventDefault()}
          onDrop={(e) => {
            const t = e.dataTransfer.getData("application/x-stockai-node");
            if (t) addAt(t, toWorld(e.clientX, e.clientY));
          }}
        >
          <div className="ed-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="ed-wires" width="1" height="1">
              {edges.map((ed) => {
                const a = portWorld(ed.from.node, ed.from.port, "out");
                const b = portWorld(ed.to.node, ed.to.port, "in");
                const isSel = sel?.kind === "edge" && sel.to.node === ed.to.node && sel.to.port === ed.to.port;
                const hot = sel?.kind === "node" && (sel.id === ed.from.node || sel.id === ed.to.node);
                return (
                  <g key={`${ed.to.node}.${ed.to.port}`}>
                    <path className="ed-hit" d={curve(a, b)} onPointerDown={(e) => (e.stopPropagation(), setSel({ kind: "edge", to: ed.to }))} />
                    <path className={`ed-wire ${isSel ? "sel" : ""} ${hot ? "hot" : ""}`} stroke={`var(--pt-${ed.type}, var(--dim))`} d={curve(a, b)} />
                  </g>
                );
              })}
              {wiring && <path className="ed-wire temp" stroke={`var(--pt-${wireType ?? "Count"}, var(--accent))`} d={curve(portWorld(wiring.from.node, wiring.from.port, "out"), { x: wiring.x, y: wiring.y })} />}
            </svg>
            {Object.entries(spec.nodes).map(([id, n]) => {
              const def = catalog.get(n.use);
              const p = pos(id);
              const ins = Object.entries(def?.inputs ?? {});
              const outs = Object.entries(def?.outputs ?? {});
              const st = runNodes[id] ?? (run ? "queued" : undefined);
              return (
                <div
                  key={id}
                  data-node={id}
                  className={`ed-node ${sel?.kind === "node" && sel.id === id ? "sel" : ""} ${badNodes.has(id) ? "bad" : ""} ${st ? `s-${st}` : ""}`}
                  style={{ left: p.x, top: p.y, width: M.NODE_W, height: M.nodeHeight(def) }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSel({ kind: "node", id });
                  }}
                >
                  <div
                    className="ed-head"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setSel({ kind: "node", id });
                      const w = toWorld(e.clientX, e.clientY);
                      setDrag({ kind: "move", id, dx: w.x - p.x, dy: w.y - p.y, moved: false });
                    }}
                  >
                    <span className="cat" style={{ background: def ? CATEGORY_HUE[def.category] ?? "var(--line-2)" : "var(--fail)" }} />
                    {st && <span className={`st-${st}`}>{GLYPH[st] ?? "·"}</span>}
                    <b className="ellipsis">{id}</b>
                    <span className="ed-type ellipsis">{def?.title ?? n.use}</span>
                    {badNodes.has(id) && <span className="fail" title={(local[id] ?? []).join("\n")}>!</span>}
                  </div>
                  {ins.map(([port, d], i) => {
                    const ok = wiring ? M.canConnect(spec, catalog, wiring.from, { node: id, port }) === null : false;
                    return (
                      <div key={`i${port}`} className="ed-row in" style={{ top: M.portY(i) - M.ROW_H / 2 }}>
                        <span
                          className={`ed-port in ${n.in[port] ? "on" : ""} ${wiring ? (ok ? "ok" : "no") : ""}`}
                          data-in-port
                          data-node={id}
                          data-port={port}
                          style={{ ["--c" as string]: `var(--pt-${d.type}, var(--dim))` }}
                          title={`${port}: ${d.type}${d.optional ? "（任意）" : ""}`}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            if (n.in[port]) setSel({ kind: "edge", to: { node: id, port } });
                          }}
                        />
                        <span className={d.optional ? "dim" : ""}>{port}{d.optional ? "?" : ""}</span>
                      </div>
                    );
                  })}
                  {outs.map(([port, d], j) => (
                    <div key={`o${port}`} className="ed-row out" style={{ top: M.portY(j) - M.ROW_H / 2 }}>
                      <span className="dim">{port}</span>
                      <span
                        className="ed-port out"
                        style={{ ["--c" as string]: `var(--pt-${d.type}, var(--dim))` }}
                        title={`${port}: ${d.type} — ドラッグしてつなぐ`}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          const w = toWorld(e.clientX, e.clientY);
                          setDrag({ kind: "wire", from: { node: id, port }, x: w.x, y: w.y });
                        }}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {nodeCount === 0 && (
            <div className="ed-empty">
              <div className="h1">空のワークフロー</div>
              <p className="dim">左のパレットからノードをクリック、またはドラッグして追加します。</p>
              <p className="faint">出力ポート（右の点）から入力ポート（左の点）へドラッグしてつなぎます。型が同じポート同士だけつながります。</p>
            </div>
          )}
          <div className="ed-hint faint">ドラッグ: 移動 · ホイール: スクロール · {MOD}ホイール: 拡大 · Del: 削除 · {MOD}Z: 元に戻す</div>
        </div>

        {/* ── inspector ── */}
        <aside className="ed-inspector">
          {sel?.kind === "node" && selNode ? (
            <NodeInspector
              prompts={promptsQ.data}
              key={sel.id}
              id={sel.id}
              node={selNode}
              def={selDef}
              spec={spec}
              catalog={catalog}
              problems={fresh ? serverProblems.filter((p) => problemNode(p, spec) === sel.id) : (local[sel.id] ?? [])}
              status={runNodes[sel.id]}
              onCommit={commit}
              onRename={(to) => {
                const r = M.renameNode(spec, sel.id, to);
                if (typeof r === "string") return r;
                commit(r);
                setSel({ kind: "node", id: to });
                return null;
              }}
              onSelectNode={(id) => setSel({ kind: "node", id })}
              onDelete={deleteSelection}
            />
          ) : sel?.kind === "edge" ? (
            <EdgeInspector spec={spec} catalog={catalog} to={sel.to} onDelete={deleteSelection} />
          ) : (
            <WorkflowInspector spec={spec} isNew={isNew} problems={allProblems} run={run} onCommit={commit} onSelect={(id) => setSel({ kind: "node", id })} />
          )}
        </aside>
      </div>
    </div>
  );
}

function Palette({ catalog, onAdd, searchRef }: { catalog: NodeDescription[]; onAdd: (type: string) => void; searchRef: React.RefObject<HTMLInputElement | null> }) {
  const [q, setQ] = useState("");
  const shown = catalog.filter((d) => !q || `${d.type} ${d.title} ${d.description}`.toLowerCase().includes(q.toLowerCase()));
  let last = "";
  return (
    <nav className="ed-palette">
      <input ref={searchRef} className="input" placeholder="ノードを検索  /" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
        if (e.key === "Enter" && shown[0]) onAdd(shown[0].type);
        if (e.key === "Escape") (e.currentTarget as HTMLInputElement).blur();
      }} />
      <div className="ed-palette-list">
        {shown.map((d) => {
          const head = d.category !== last ? <div className="list-group">{CATEGORY_JA[d.category] ?? d.category}</div> : null;
          last = d.category;
          return (
            <div key={d.type}>
              {head}
              <div
                className="ed-pal-item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-stockai-node", d.type);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onAdd(d.type)}
                title={d.description}
              >
                <span className="cat" style={{ background: CATEGORY_HUE[d.category] ?? "var(--line-2)" }} />
                <span className="ellipsis">{d.title}</span>
                <span className="faint ellipsis">{d.type}</span>
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function NodeInspector(props: {
  id: string;
  node: M.NodeCfg;
  def: NodeDescription | undefined;
  spec: M.Spec;
  catalog: M.Catalog;
  problems: string[];
  status: string | undefined;
  onCommit: (s: M.Spec) => void;
  onRename: (to: string) => string | null;
  onSelectNode: (id: string) => void;
  onDelete: () => void;
  prompts?: PromptsView | undefined;
}) {
  const { id, node, def, spec, catalog } = props;
  const [idText, setIdText] = useState(id);
  const [idErr, setIdErr] = useState<string | null>(null);
  const [afterText, setAfterText] = useState(node.after.join(", "));
  const consumers = (port: string) =>
    Object.entries(spec.nodes).flatMap(([k, n]) =>
      Object.entries(n.in).filter(([, r]) => {
        const ref = M.parseRef(r, spec, catalog);
        return ref?.node === id && ref.port === port;
      }).map(([p]) => `${k}.${p}`),
    );
  const commitAfter = () => {
    const list = afterText.split(/[\s,]+/).filter(Boolean);
    const unknown = list.filter((a) => !spec.nodes[a] || a === id);
    if (unknown.length) return setAfterText(node.after.join(", "));
    props.onCommit(M.patchNode(spec, id, { after: list }));
  };
  return (
    <div className="ed-insp">
      <div className="ed-insp-head">
        <input
          className={`input ed-id ${idErr ? "bad" : ""}`}
          value={idText}
          onChange={(e) => setIdText(e.target.value)}
          onBlur={() => setIdErr(props.onRename(idText.trim()))}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          aria-label="ノード ID"
        />
        {props.status && <span className={`st-${props.status}`}>{GLYPH[props.status]} {props.status}</span>}
      </div>
      {idErr && <div className="fail">✕ {idErr}</div>}
      <div className="dim">{def ? `${def.title} · ${def.type}` : <span className="fail">未知の種類 {node.use}</span>}</div>
      {def && <p className="faint ed-desc">{def.description}</p>}
      {props.problems.length > 0 && <div className="callout fail">{props.problems.map((p) => <div key={p}>✕ {p}</div>)}</div>}

      <h4>入力</h4>
      {Object.entries(def?.inputs ?? {}).length === 0 && <div className="faint">なし</div>}
      {Object.entries(def?.inputs ?? {}).map(([port, d]) => {
        const ref = node.in[port];
        return (
          <div key={port} className="ed-io">
            <span>{port}{d.optional ? <span className="faint">?</span> : ""}</span>
            <PortType t={d.type} />
            {ref ? (
              <span className="ed-io-src">
                ← <a className="accent" onClick={() => props.onSelectNode(ref.split(".")[0]!)}>{ref}</a>{" "}
                <button className="ed-link" onClick={() => props.onCommit(M.disconnect(spec, { node: id, port }))}>切断</button>
              </span>
            ) : (
              <span className={d.optional ? "faint" : "warn"}>{d.optional ? "未接続（任意）" : "未接続"}</span>
            )}
          </div>
        );
      })}
      <h4>出力</h4>
      {Object.entries(def?.outputs ?? {}).map(([port, d]) => {
        const to = consumers(port);
        return (
          <div key={port} className="ed-io">
            <span>{port}</span>
            <PortType t={d.type} />
            <span className="faint ed-io-src">{to.length ? `→ ${to.join(", ")}` : "未使用"}</span>
          </div>
        );
      })}

      <h4>パラメータ</h4>
      <ParamsForm key={id} schema={def?.paramsSchema} values={node.params} onSet={(k, v) => props.onCommit(M.setParam(spec, id, k, v))} choices={promptChoices(node.use, props.prompts)} />

      <h4>実行時の扱い</h4>
      <label className="ed-field">
        <div className="ed-plabel-row"><span>onError</span><span className="faint">失敗したとき</span></div>
        <select className="input" value={node.onError} onChange={(e) => props.onCommit(M.patchNode(spec, id, { onError: e.target.value as M.OnError }))}>
          <option value="abort">abort — 全体を止める</option>
          <option value="skip">skip — 後続だけ飛ばす</option>
          <option value="fallback" disabled={!def?.hasFallback}>fallback — 安全な既定値{def?.hasFallback ? "" : "（このノードは不可）"}</option>
        </select>
      </label>
      <label className="ed-check">
        <input type="checkbox" checked={node.cache} onChange={(e) => props.onCommit(M.patchNode(spec, id, { cache: e.target.checked }))} disabled={def?.cache === "none"} />
        <span>キャッシュを使う <span className="faint">{def?.cache === "none" ? "（副作用のあるノードは常に実行）" : `（${def?.cache}）`}</span></span>
      </label>
      <label className="ed-field">
        <div className="ed-plabel-row"><span>after</span><span className="faint">データなしで先に終わらせるノード</span></div>
        <input className="input" value={afterText} onChange={(e) => setAfterText(e.target.value)} onBlur={commitAfter} placeholder="例: record" />
      </label>

      <div className="ed-insp-foot">
        <button className="btn danger" onClick={props.onDelete}>ノードを削除 <kbd>Del</kbd></button>
      </div>
    </div>
  );
}

function EdgeInspector({ spec, catalog, to, onDelete }: { spec: M.Spec; catalog: M.Catalog; to: M.PortRef; onDelete: () => void }) {
  const ref = spec.nodes[to.node]?.in[to.port];
  const from = ref ? M.parseRef(ref, spec, catalog) : null;
  const type = catalog.get(spec.nodes[to.node]?.use ?? "")?.inputs[to.port]?.type ?? "?";
  return (
    <div className="ed-insp">
      <div className="ed-insp-head"><b>接続</b> <PortType t={type} /></div>
      <dl className="kv">
        <dt>から</dt><dd>{from ? `${from.node}.${from.port}` : ref ?? "—"}</dd>
        <dt>へ</dt><dd>{to.node}.{to.port}</dd>
      </dl>
      <div className="ed-insp-foot"><button className="btn danger" onClick={onDelete}>接続を削除 <kbd>Del</kbd></button></div>
    </div>
  );
}

function WorkflowInspector(props: {
  spec: M.Spec;
  isNew: boolean;
  problems: string[];
  run: { runId: string; status: string; nodes: Record<string, string> } | null;
  onCommit: (s: M.Spec) => void;
  onSelect: (id: string) => void;
}) {
  const { spec } = props;
  const [desc, setDesc] = useState(spec.description);
  useEffect(() => setDesc(spec.description), [spec.description]);
  return (
    <div className="ed-insp">
      <div className="ed-insp-head"><b>ワークフロー</b></div>
      <label className="ed-field">
        <div className="ed-plabel-row"><span>説明</span></div>
        <textarea className="input" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => props.onCommit({ ...spec, description: desc })} />
      </label>
      {props.isNew && !M.NAME_RE.test(spec.name) && <div className="fail">名前は英小文字・数字・- _ のみ（上のツールバーで編集）</div>}

      {props.run && (
        <>
          <h4>実行</h4>
          <div className={`st-${props.run.status}`}>{GLYPH[props.run.status] ?? "·"} {props.run.status}</div>
          <a className="accent" onClick={() => navigate("runs", props.run!.runId)}>結果を見る →</a>
        </>
      )}

      <h4>検証 {props.problems.length ? <span className="fail">{props.problems.length}</span> : <span className="ok">OK</span>}</h4>
      {props.problems.length === 0 ? (
        <div className="faint">問題はありません。</div>
      ) : (
        <div className="ed-problems">
          {props.problems.map((p) => {
            const id = problemNode(p, spec);
            return (
              <div key={p} className={id ? "clickable" : ""} onClick={() => id && props.onSelect(id)}>
                <span className="fail">✕</span> {p}
              </div>
            );
          })}
        </div>
      )}

      <h4>操作</h4>
      <table className="t ed-keys">
        <tbody>
          {[
            ["ノード追加", "パレットをクリック / ドラッグ"],
            ["接続", "出力ポート → 入力ポートへドラッグ"],
            ["削除", "選択して Del"],
            ["元に戻す / やり直し", `${MOD}Z / ${MOD}⇧Z`],
            ["保存", `${MOD}S`],
            ["整列 / 全体表示", "l / f"],
            ["拡大縮小", `${MOD}ホイール, + / -`],
            ["検索", "/"],
          ].map(([a, b]) => <tr key={a}><td className="dim nowrap">{a}</td><td className="fg2">{b}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
