const STORAGE_KEY = "nodex-page-stage-viewport-v2";
const LEGACY_STORAGE_KEY = "nodex-page-stage-scroll-v1";
const MAX_ENTRIES = 200;

interface PageStageViewportSnapshotBase {
  readonly version: 2;
}

export type PageStageViewportSnapshot =
  | (PageStageViewportSnapshotBase & { readonly kind: "top" })
  | (PageStageViewportSnapshotBase & {
      readonly kind: "bottom";
      readonly gapPx: number;
    })
  | (PageStageViewportSnapshotBase & {
      readonly kind: "offset";
      readonly scrollTop: number;
    })
  | (PageStageViewportSnapshotBase & {
      readonly kind: "anchor";
      readonly blockId: string;
      readonly viewportOffsetPx: number;
      readonly fallbackScrollTop: number;
    });

type ViewportMap = Record<string, PageStageViewportSnapshot>;
type LegacyScrollMap = Record<string, number>;

const hotSnapshots = new Map<string, PageStageViewportSnapshot>();

function makeKey(documentScopeKey: string, pageId: string, editorSessionKey?: string): string {
  if (editorSessionKey) return `page-stage-session:${editorSessionKey}`;
  return `page-stage:${documentScopeKey}:${pageId}`;
}

function makeLegacyKey(
  documentScopeKey: string,
  pageId: string,
  editorSessionKey?: string,
): string {
  if (editorSessionKey) return `page-stage-session:${editorSessionKey}`;
  const legacyProjectId = documentScopeKey.startsWith("project:")
    ? documentScopeKey.slice("project:".length)
    : documentScopeKey;
  return `page-stage:${legacyProjectId}:${pageId}`;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decodeSnapshot(value: unknown): PageStageViewportSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 2 || typeof candidate.kind !== "string") return null;

  if (candidate.kind === "top") return { version: 2, kind: "top" };
  if (candidate.kind === "bottom" && isNonNegativeFiniteNumber(candidate.gapPx)) {
    return { version: 2, kind: "bottom", gapPx: candidate.gapPx };
  }
  if (candidate.kind === "offset" && isNonNegativeFiniteNumber(candidate.scrollTop)) {
    return { version: 2, kind: "offset", scrollTop: candidate.scrollTop };
  }
  if (
    candidate.kind !== "anchor" ||
    typeof candidate.blockId !== "string" ||
    candidate.blockId.length === 0 ||
    typeof candidate.viewportOffsetPx !== "number" ||
    !Number.isFinite(candidate.viewportOffsetPx) ||
    !isNonNegativeFiniteNumber(candidate.fallbackScrollTop)
  ) {
    return null;
  }

  return {
    version: 2,
    kind: "anchor",
    blockId: candidate.blockId,
    viewportOffsetPx: candidate.viewportOffsetPx,
    fallbackScrollTop: candidate.fallbackScrollTop,
  };
}

function readViewportMap(): ViewportMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    const result: ViewportMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      const snapshot = decodeSnapshot(value);
      if (snapshot) result[key] = snapshot;
    }
    return result;
  } catch {
    return {};
  }
}

function readLegacyScrollMap(): LegacyScrollMap {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    const result: LegacyScrollMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isNonNegativeFiniteNumber(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeViewportMap(map: ViewportMap): void {
  try {
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[key];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable in restricted renderer contexts.
  }
}

function rememberHotSnapshot(key: string, snapshot: PageStageViewportSnapshot): void {
  hotSnapshots.delete(key);
  hotSnapshots.set(key, snapshot);
  while (hotSnapshots.size > MAX_ENTRIES) {
    const oldestKey = hotSnapshots.keys().next().value;
    if (typeof oldestKey !== "string") return;
    hotSnapshots.delete(oldestKey);
  }
}

export function rememberPageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  snapshot: PageStageViewportSnapshot,
  editorSessionKey?: string,
): void {
  rememberHotSnapshot(makeKey(documentScopeKey, pageId, editorSessionKey), snapshot);
}

export function savePageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  snapshot: PageStageViewportSnapshot,
  editorSessionKey?: string,
): void {
  const key = makeKey(documentScopeKey, pageId, editorSessionKey);
  rememberHotSnapshot(key, snapshot);
  const map = readViewportMap();
  delete map[key];
  map[key] = snapshot;
  writeViewportMap(map);
}

export function loadPageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  editorSessionKey?: string,
): PageStageViewportSnapshot | null {
  const key = makeKey(documentScopeKey, pageId, editorSessionKey);
  const hotSnapshot = hotSnapshots.get(key);
  if (hotSnapshot) return hotSnapshot;

  const snapshot = readViewportMap()[key];
  if (snapshot) {
    rememberHotSnapshot(key, snapshot);
    return snapshot;
  }

  const legacyScrollTop =
    readLegacyScrollMap()[makeLegacyKey(documentScopeKey, pageId, editorSessionKey)];
  if (!isNonNegativeFiniteNumber(legacyScrollTop)) return null;
  const migrated: PageStageViewportSnapshot = {
    version: 2,
    kind: "offset",
    scrollTop: legacyScrollTop,
  };
  rememberHotSnapshot(key, migrated);
  return migrated;
}

export function forgetPageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  editorSessionKey?: string,
): void {
  const key = makeKey(documentScopeKey, pageId, editorSessionKey);
  hotSnapshots.delete(key);

  const map = readViewportMap();
  delete map[key];
  writeViewportMap(map);

  try {
    const legacyMap = readLegacyScrollMap();
    delete legacyMap[makeLegacyKey(documentScopeKey, pageId, editorSessionKey)];
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacyMap));
  } catch {
    // localStorage may be unavailable in restricted renderer contexts.
  }
}
