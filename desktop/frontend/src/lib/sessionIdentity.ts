/** Session identity fields used by hydration and history-page fences. */
export type SessionIdentity = { sessionPath?: string; sessionGeneration?: number };

export function normalizeSessionGeneration(generation: number | undefined): number {
  // The Wails API omits uint64's zero value. Treat omission as generation 0
  // everywhere so it cannot act like a wildcard during a later rebind.
  return generation ?? 0;
}

export const sessionIdentityCurrent = (path: string, generation: number | undefined, meta?: SessionIdentity): boolean => Boolean(meta && hydrateIdentityCurrent(path, generation, meta.sessionPath, meta.sessionGeneration));

export function preserveSessionIdentity<T extends SessionIdentity>(meta: T, previous?: SessionIdentity): T {
  return { ...meta, ...(meta.sessionPath === undefined && previous?.sessionPath !== undefined ? { sessionPath: previous.sessionPath } : {}), ...(meta.sessionGeneration === undefined && previous?.sessionGeneration !== undefined ? { sessionGeneration: previous.sessionGeneration } : {}) };
}

/** True when a hydrate started for loadPath/loadGen still matches live meta. */
export function hydrateIdentityCurrent(
  loadPath: string,
  loadGeneration: number | undefined,
  metaPath: string | undefined,
  metaGeneration: number | undefined,
): boolean {
  const path = loadPath.trim();
  if (path && metaPath && metaPath !== path) return false;
  if (!path) return true;
  if (normalizeSessionGeneration(loadGeneration) !== normalizeSessionGeneration(metaGeneration)) return false;
  return true;
}
