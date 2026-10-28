import { useState, type CSSProperties, type DragEvent } from "react";
import { useI18n } from "../lib/i18n";
import { normalizeMirrorURL, useUpdateSource, type UpdateMirror } from "../lib/updateSource";

// 文案随组件走，不进 locale bundle：zh/zh-TW 包已顶到 gzip 上限。
const COPY = {
  en: {
    label: "Update source",
    toggle: "Use mirrors to speed up downloads",
    hint: "Tried in order below; falls back to the official source (always last) when all fail.",
    fallback: "Fallback when all mirrors fail",
    official: "Official (GitHub)",
    fixed: "Fixed last",
    mirror: "Mirror",
    add: "+ Add mirror",
    restore: "Restore defaults",
    probe: "Test all",
    sort: "Sort by speed",
    remove: "Remove",
    addTitle: "Mirror prefix (https only)",
    addPlaceholder: "https://your-mirror.example.com",
    addConfirm: "Add",
    addCancel: "Cancel",
    invalidURL: "Enter an https:// address",
    duplicate: "That mirror is already in the list",
    untested: "—",
    offSuffix: "disabled",
    enabledUnit: "enabled",
    switchAria: "Mirror download switch",
    probing: "Testing…",
    enableMirror: "Enable (keeps the setting)",
    disableMirror: "Disable (keeps the setting)",
    officialOnly: "Off — official source only",
  },
  zh: {
    label: "更新源",
    toggle: "使用镜像加速下载",
    hint: "按下列顺序逐个尝试，全部失败时自动回退到官方直连（固定最后）。",
    fallback: "全部失败时回退",
    official: "官方直连（GitHub）",
    fixed: "固定最后",
    mirror: "镜像",
    add: "+ 添加镜像",
    restore: "恢复默认镜像",
    probe: "测试全部",
    sort: "按速度排序",
    remove: "删除",
    addTitle: "镜像前缀（仅支持 https）",
    addPlaceholder: "https://你的镜像.example.com",
    addConfirm: "添加",
    addCancel: "取消",
    invalidURL: "请填写 https:// 开头的地址",
    duplicate: "该镜像已在列表中",
    untested: "—",
    offSuffix: "个已停用",
    enabledUnit: "个启用",
    switchAria: "镜像加速开关",
    probing: "测试中…",
    enableMirror: "点击启用",
    disableMirror: "点击停用（保留设置）",
    officialOnly: "已停用 · 仅用官方直连",
  },
  "zh-TW": {
    label: "更新源",
    toggle: "使用鏡像加速下載",
    hint: "按下列順序逐個嘗試，全部失敗時自動回退到官方直連（固定最後）。",
    fallback: "全部失敗時回退",
    official: "官方直連（GitHub）",
    fixed: "固定最後",
    mirror: "鏡像",
    add: "+ 新增鏡像",
    restore: "恢復預設鏡像",
    probe: "測試全部",
    sort: "按速度排序",
    remove: "刪除",
    addTitle: "鏡像前綴（僅支援 https）",
    addPlaceholder: "https://你的鏡像.example.com",
    addConfirm: "新增",
    addCancel: "取消",
    invalidURL: "請填寫 https:// 開頭的位址",
    duplicate: "該鏡像已在清單中",
    untested: "—",
    offSuffix: "個已停用",
    enabledUnit: "個啟用",
    switchAria: "鏡像加速開關",
    probing: "測試中…",
    enableMirror: "點擊啟用",
    disableMirror: "點擊停用（保留設定）",
    officialOnly: "已停用 · 僅用官方直連",
  },
} as const;

const S: Record<string, CSSProperties> = {
  card: { border: "1px solid var(--border)", borderRadius: 8, marginBottom: 12, background: "var(--bg-elev)" },
  head: { display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", cursor: "pointer" },
  headLabel: { color: "var(--fg-dim)", fontSize: "var(--font-control-small)", flex: "0 0 auto" },
  grow: { flex: "1 1 auto", minWidth: 0 },
  meta: { color: "var(--fg-faint)", fontSize: "var(--font-caption)", flex: "0 0 auto" },
  chev: { color: "var(--fg-faint)", fontSize: 10, flex: "0 0 auto" },
  body: { borderTop: "1px solid var(--border)", padding: "9px 10px 10px" },
  hint: { color: "var(--fg-faint)", fontSize: "var(--font-caption)", marginBottom: 7 },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", borderRadius: 6 },
  rowOff: { opacity: 0.55 },
  grip: { width: 14, textAlign: "center", color: "var(--fg-faint)", cursor: "grab", userSelect: "none", flex: "0 0 auto" },
  gripFixed: { cursor: "default", opacity: 0.35 },
  name: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--font-control-small)" },
  nameOff: { textDecoration: "line-through", color: "var(--fg-faint)" },
  lat: { fontSize: "var(--font-caption)", fontVariantNumeric: "tabular-nums", flex: "0 0 auto", minWidth: 46, textAlign: "right" },
  tag: { fontSize: "var(--font-caption)", color: "var(--fg-faint)", border: "1px solid var(--border)", borderRadius: 999, padding: "0 6px", flex: "0 0 auto" },
  act: { background: "none", border: "none", color: "var(--fg-faint)", cursor: "pointer", fontSize: "var(--font-caption)", fontFamily: "inherit", padding: "2px 4px", flex: "0 0 auto" },
  sep: { display: "flex", alignItems: "center", gap: 8, color: "var(--fg-faint)", fontSize: "var(--font-caption)", margin: "5px 0 2px", paddingLeft: 2 },
  sepLine: { flex: "1 1 auto", height: 1, background: "var(--border)" },
  tools: { display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap", alignItems: "center" },
  btn: { border: "1px solid var(--border)", background: "var(--bg-elev)", color: "var(--fg)", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: "var(--font-caption)", fontFamily: "inherit" },
  input: { flex: "1 1 180px", minWidth: 0, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--fg)", borderRadius: 6, padding: "3px 8px", fontSize: "var(--font-caption)", fontFamily: "inherit" },
  err: { color: "var(--danger, #b91c1c)", fontSize: "var(--font-caption)", marginTop: 6 },
};

function switchStyle(on: boolean, compact = false): CSSProperties {
  const w = compact ? 28 : 34;
  const h = compact ? 16 : 19;
  return {
    width: w,
    height: h,
    borderRadius: 999,
    border: "none",
    padding: 0,
    position: "relative",
    cursor: "pointer",
    flex: "0 0 auto",
    background: on ? "var(--accent)" : "var(--border)",
    transition: "background .14s",
  };
}

function knobStyle(on: boolean, compact = false): CSSProperties {
  const size = compact ? 12 : 15;
  return {
    position: "absolute",
    top: 2,
    left: on ? (compact ? 14 : 17) : 2,
    width: size,
    height: size,
    borderRadius: "50%",
    background: "#fff",
    transition: "left .16s ease",
    boxShadow: "0 1px 2px rgba(0,0,0,.25)",
  };
}

function latencyText(m: UpdateMirror, untested: string): string {
  if (m.probeError) return "×";
  if (m.latencyMs == null) return untested;
  return (m.latencyMs / 1000).toFixed(1) + "s";
}

function latencyColor(m: UpdateMirror): string {
  if (m.probeError) return "var(--danger, #b91c1c)";
  if (m.latencyMs == null) return "var(--fg-faint)";
  return m.latencyMs > 5000 ? "var(--warn, #b45309)" : "var(--ok, #15803d)";
}

export function UpdateSourceSettings({ settingsBusy = false }: { settingsBusy?: boolean }) {
  const { locale } = useI18n();
  const c = COPY[locale as keyof typeof COPY] ?? COPY.en;
  const { config, probing, error, setEnabled, toggleMirror, addMirror, removeMirror, moveMirror, restoreDefaults, probe, sortBySpeed } =
    useUpdateSource();

  const [open, setOpen] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");

  const busy = settingsBusy || probing;
  const active = config.mirrors.filter((m) => m.enabled);
  const offCount = config.mirrors.length - active.length;
  const fastest = active.filter((m) => m.latencyMs != null).sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0))[0];
  const meta = !config.enabled
    ? c.officialOnly
    : `${active.length} ${c.enabledUnit}${offCount ? ` · ${offCount} ${c.offSuffix}` : ""}${fastest ? ` · ${(fastest.latencyMs! / 1000).toFixed(1)}s` : ""}`;

  const onDrop = (to: number) => {
    if (dragFrom !== null) moveMirror(dragFrom, to);
    setDragFrom(null);
    setDragOver(null);
  };

  const submitDraft = () => {
    const url = normalizeMirrorURL(draft);
    if (!url) return setDraftError(c.invalidURL);
    if (config.mirrors.some((m) => m.url === url)) return setDraftError(c.duplicate);
    if (!addMirror(draft)) return setDraftError(c.invalidURL);
    setDraft("");
    setDraftError("");
    setAdding(false);
  };

  return (
    <div style={S.card}>
      <div style={S.head} onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}>
        <span style={S.headLabel}>{c.label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={config.enabled}
          aria-label={c.switchAria}
          disabled={busy}
          style={switchStyle(config.enabled)}
          onClick={(e) => { e.stopPropagation(); void setEnabled(!config.enabled); }}
        >
          <span style={knobStyle(config.enabled)} />
        </button>
        <span style={{ ...S.grow, fontSize: "var(--font-control-small)" }}>{c.toggle}</span>
        <span style={S.meta}>{probing ? c.probing : meta}</span>
        <span style={{ ...S.chev, transform: open ? "rotate(180deg)" : undefined }}>▾</span>
      </div>

      {open && (
        <div style={S.body}>
          <div style={S.hint}>{c.hint}</div>

          {config.enabled && config.mirrors.map((m, i) => (
            <div
              key={m.url}
              draggable={!busy}
              onDragStart={() => setDragFrom(i)}
              onDragEnd={() => { setDragFrom(null); setDragOver(null); }}
              onDragOver={(e: DragEvent) => { e.preventDefault(); setDragOver(i); }}
              onDrop={() => onDrop(i)}
              style={{
                ...S.row,
                ...(m.enabled ? null : S.rowOff),
                ...(dragOver === i ? { outline: "1px solid var(--accent)", background: "var(--accent-soft)" } : null),
              }}
            >
              <span style={S.grip} title={c.mirror}>⠿</span>
              <span style={{ ...S.name, ...(m.enabled ? null : S.nameOff) }} title={m.url}>{m.url}</span>
              <span style={S.tag}>{c.mirror}</span>
              <button
                type="button"
                role="switch"
                aria-checked={m.enabled}
                aria-label={m.enabled ? c.disableMirror : c.enableMirror}
                title={m.enabled ? c.disableMirror : c.enableMirror}
                disabled={busy}
                style={switchStyle(m.enabled, true)}
                onClick={() => void toggleMirror(m.url, !m.enabled)}
              >
                <span style={knobStyle(m.enabled, true)} />
              </button>
              <span style={{ ...S.lat, color: latencyColor(m) }}>{latencyText(m, c.untested)}</span>
              <button type="button" style={S.act} disabled={busy} onClick={() => void removeMirror(m.url)}>{c.remove}</button>
            </div>
          ))}

          {config.enabled && (
            <div style={S.sep}><span>{c.fallback}</span><span style={S.sepLine} /></div>
          )}

          <div style={{ ...S.row, ...S.rowOff, cursor: "default" }}>
            <span style={{ ...S.grip, ...S.gripFixed }}>·</span>
            <span style={S.name}>{c.official}</span>
            <span style={S.tag}>{c.fixed}</span>
            <span style={{ ...S.lat, color: "var(--fg-faint)" }}>{c.untested}</span>
            <span style={{ ...S.act, visibility: "hidden" }}>{c.remove}</span>
          </div>

          {config.enabled && (
            <div style={S.tools}>
              <button type="button" style={S.btn} disabled={busy} onClick={() => { setAdding(true); setDraftError(""); }}>{c.add}</button>
              <button type="button" style={S.btn} disabled={busy} onClick={() => void restoreDefaults()}>{c.restore}</button>
              <span style={S.grow} />
              <button type="button" style={S.btn} disabled={busy} onClick={() => void probe()}>{c.probe}</button>
              <button type="button" style={S.btn} disabled={busy} onClick={() => void sortBySpeed()}>{c.sort}</button>
            </div>
          )}

          {adding && (
            <div style={{ ...S.tools, marginTop: 7 }}>
              <input
                style={S.input}
                value={draft}
                autoFocus
                placeholder={c.addPlaceholder}
                aria-label={c.addTitle}
                onChange={(e) => { setDraft(e.target.value); setDraftError(""); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); submitDraft(); }
                  if (e.key === "Escape") { setAdding(false); setDraft(""); setDraftError(""); }
                }}
              />
              <button type="button" style={S.btn} onClick={submitDraft}>{c.addConfirm}</button>
              <button type="button" style={S.btn} onClick={() => { setAdding(false); setDraft(""); setDraftError(""); }}>{c.addCancel}</button>
            </div>
          )}

          {draftError && <div style={S.err}>{draftError}</div>}
          {error && <div style={S.err}>{error}</div>}
        </div>
      )}
    </div>
  );
}
