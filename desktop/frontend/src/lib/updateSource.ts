import { useCallback, useEffect, useRef, useState } from "react";
import { app } from "./bridge";

/**
 * 更新源（GitHub 镜像）设置。
 *
 * 镜像只做「前缀代理」：请求地址是 `<镜像>/<官方 GitHub URL>`，所以镜像
 * 无法伪造内容 —— installer 的 minisign 校验与内嵌公钥是最终防线，这里只
 * 决定「向谁要文件」。官方源永远固定排在最后，作为全部镜像失败后的回退。
 */

export interface UpdateMirror {
  /** 前缀，如 https://gh-proxy.com，不带尾斜杠。 */
  url: string;
  /** 关掉只是不再尝试，设置与顺序都保留。 */
  enabled: boolean;
  /** 最近一次测速结果，仅存在于内存，不落配置。 */
  latencyMs?: number | null;
  /** 最近一次测速失败原因；有值时该行标记为不可用。 */
  probeError?: string;
}

export interface UpdateSourceConfig {
  /** 总开关：关闭后完全不碰镜像，只走官方源。 */
  enabled: boolean;
  mirrors: UpdateMirror[];
}

/** 后端 JSON 形状（设置面板读写用）。停用以 disabled 表达，零值即启用。 */
export interface UpdateSourceMirrorView {
  url: string;
  disabled?: boolean;
}

export interface UpdateSourceView {
  enabled: boolean;
  mirrors: UpdateSourceMirrorView[];
}

/** 后端测速返回：一次一个镜像的结果。 */
export interface UpdateMirrorProbe {
  url: string;
  latencyMs: number;
  error?: string;
}

/** 内置镜像：2026-10-28 用真实 latest.json 实测可用。 */
export const BUILTIN_MIRRORS = [
  "https://gh-proxy.com",
  "https://ghfast.top",
  "https://githubproxy.cc",
  "https://ghproxy.imciel.com",
] as const;

const CONFIG_KEY = "reasonix-update-source";

export function defaultUpdateSource(): UpdateSourceConfig {
  return {
    enabled: true,
    mirrors: BUILTIN_MIRRORS.map((url) => ({ url, enabled: true })),
  };
}

/** 只接受 https，并去掉尾斜杠；返回空串表示无效。 */
export function normalizeMirrorURL(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") return "";
  return trimmed;
}

function sanitize(input: unknown): UpdateSourceConfig {
  const fallback = defaultUpdateSource();
  if (!input || typeof input !== "object") return fallback;
  const raw = input as Partial<UpdateSourceConfig>;
  const mirrors: UpdateMirror[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.mirrors) ? raw.mirrors : []) {
    const url = normalizeMirrorURL(String((entry as UpdateMirror)?.url ?? ""));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    mirrors.push({ url, enabled: (entry as UpdateMirror)?.enabled !== false });
  }
  return {
    enabled: raw.enabled !== false,
    // 全部被删空时回落到内置，避免用户把自己锁在没有镜像的状态里。
    mirrors: mirrors.length > 0 ? mirrors : fallback.mirrors,
  };
}

/**
 * 优先走后端持久化；后端方法尚未提供时退回 localStorage，让前端可以独立
 * 预览与迭代，接入后自动切到真实配置。
 *
 * 后端以 `disabled` 表达停用（零值即启用），前端内部统一用 `enabled`，
 * 两处转换都收敛在这里，避免「停用的镜像被当成启用」。
 */
function fromView(view: UpdateSourceView): UpdateSourceConfig {
  return {
    enabled: view.enabled !== false,
    mirrors: (view.mirrors ?? []).map((m) => ({ url: m.url, enabled: m.disabled !== true })),
  };
}

function toView(config: UpdateSourceConfig): UpdateSourceView {
  return {
    enabled: config.enabled,
    mirrors: config.mirrors.map((m) => ({ url: m.url, disabled: !m.enabled })),
  };
}

async function readConfig(): Promise<UpdateSourceConfig> {
  const backend = (app as unknown as { GetUpdateSource?: () => Promise<UpdateSourceView> }).GetUpdateSource;
  if (typeof backend === "function") {
    try {
      return sanitize(fromView(await backend()));
    } catch {
      /* 落到本地缓存 */
    }
  }
  try {
    const cached = window.localStorage.getItem(CONFIG_KEY);
    return cached ? sanitize(JSON.parse(cached)) : defaultUpdateSource();
  } catch {
    return defaultUpdateSource();
  }
}

async function writeConfig(next: UpdateSourceConfig): Promise<void> {
  const backend = (app as unknown as { SetUpdateSource?: (view: UpdateSourceView) => Promise<void> }).SetUpdateSource;
  if (typeof backend === "function") {
    await backend(toView(next));
    return;
  }
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  } catch {
    /* 忽略存储失败：内存态仍然可用 */
  }
}

export interface MirrorProbeResult {
  url: string;
  latencyMs: number | null;
  error?: string;
}

export function useUpdateSource() {
  const [config, setConfig] = useState<UpdateSourceConfig>(defaultUpdateSource);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState("");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    void (async () => {
      const loaded = await readConfig();
      if (!aliveRef.current) return;
      setConfig(loaded);
      setLoading(false);
    })();
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const commit = useCallback(async (next: UpdateSourceConfig) => {
    const clean = sanitize(next);
    setConfig(clean);
    try {
      await writeConfig(clean);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => commit({ ...config, enabled }),
    [commit, config],
  );

  const toggleMirror = useCallback(
    (url: string, enabled: boolean) =>
      commit({
        ...config,
        mirrors: config.mirrors.map((m) => (m.url === url ? { ...m, enabled } : m)),
      }),
    [commit, config],
  );

  const removeMirror = useCallback(
    (url: string) => commit({ ...config, mirrors: config.mirrors.filter((m) => m.url !== url) }),
    [commit, config],
  );

  const addMirror = useCallback(
    (raw: string): boolean => {
      const url = normalizeMirrorURL(raw);
      if (!url) return false;
      if (config.mirrors.some((m) => m.url === url)) return false;
      void commit({ ...config, mirrors: [...config.mirrors, { url, enabled: true }] });
      return true;
    },
    [commit, config],
  );

  const moveMirror = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || to < 0) return;
      if (from >= config.mirrors.length || to >= config.mirrors.length) return;
      const next = config.mirrors.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void commit({ ...config, mirrors: next });
    },
    [commit, config],
  );

  /** 恢复默认：内置回到最前并复位为启用，自定义项原样保留在后面。 */
  const restoreDefaults = useCallback(() => {
    const builtins = new Set<string>(BUILTIN_MIRRORS);
    const customs = config.mirrors.filter((m) => !builtins.has(m.url));
    const restored = BUILTIN_MIRRORS.map((url) => {
      const existing = config.mirrors.find((m) => m.url === url);
      return { url, enabled: true, latencyMs: existing?.latencyMs ?? null };
    });
    void commit({ enabled: true, mirrors: [...restored, ...customs] });
  }, [commit, config]);

  /**
   * 并发测速，取最慢者作为总耗时；只更新延迟，不改变顺序。
   * 「按速度排序」是独立动作，避免测一次就被静默重排。
   */
  const probe = useCallback(async () => {
    setProbing(true);
    setError("");
    try {
      const backend = (app as unknown as {
        TestUpdateMirrors?: (urls: string[]) => Promise<MirrorProbeResult[]>;
      }).TestUpdateMirrors;
      let results: MirrorProbeResult[];
      if (typeof backend === "function") {
        results = await backend(config.mirrors.map((m) => m.url));
      } else {
        // 后端未接入时的本地近似：真实浏览器请求拿相对快慢。
        results = await Promise.all(
          config.mirrors.map(async (m): Promise<MirrorProbeResult> => {
            const started = performance.now();
            try {
              await fetch(`${m.url}/https://github.com/keeyangyy/DeepSeek-Reasonix/releases/download/wails-latest/versions.json`, {
                method: "HEAD",
                signal: AbortSignal.timeout(10_000),
              });
              return { url: m.url, latencyMs: Math.round(performance.now() - started) };
            } catch (err) {
              return { url: m.url, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
            }
          }),
        );
      }
      if (!aliveRef.current) return;
      const byURL = new Map(results.map((r) => [r.url, r]));
      setConfig((prev) => ({
        ...prev,
        mirrors: prev.mirrors.map((m) => {
          const hit = byURL.get(m.url);
          return hit ? { ...m, latencyMs: hit.latencyMs, probeError: hit.error } : m;
        }),
      }));
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setProbing(false);
    }
  }, [config.mirrors]);

  /** 按已有延迟重排：启用的按快慢在前，未测过或测速失败的排后面。 */
  const sortBySpeed = useCallback(() => {
    const rank = (m: UpdateMirror) => (m.enabled ? 0 : 1);
    const delay = (m: UpdateMirror) => (m.latencyMs == null ? Number.MAX_SAFE_INTEGER : m.latencyMs);
    const next = config.mirrors.slice().sort((a, b) => rank(a) - rank(b) || delay(a) - delay(b));
    void commit({ ...config, mirrors: next });
  }, [commit, config]);

  return {
    config,
    loading,
    probing,
    error,
    setEnabled,
    toggleMirror,
    addMirror,
    removeMirror,
    moveMirror,
    restoreDefaults,
    probe,
    sortBySpeed,
  };
}
