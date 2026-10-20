import { createViewportMemory } from "./viewport-memory";

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

type LegacyScrollMap = Record<string, number>;

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

const memory = createViewportMemory({
  storageKey: STORAGE_KEY,
  decode: decodeSnapshot,
  maxEntries: MAX_ENTRIES,
});

export function rememberPageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  snapshot: PageStageViewportSnapshot,
  editorSessionKey?: string,
): void {
  memory.remember(makeKey(documentScopeKey, pageId, editorSessionKey), snapshot);
}

export function savePageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  snapshot: PageStageViewportSnapshot,
  editorSessionKey?: string,
): void {
  memory.save(makeKey(documentScopeKey, pageId, editorSessionKey), snapshot);
}

export function loadPageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  editorSessionKey?: string,
): PageStageViewportSnapshot | null {
  const key = makeKey(documentScopeKey, pageId, editorSessionKey);
  const snapshot = memory.load(key);
  if (snapshot) return snapshot;

  const legacyScrollTop =
    readLegacyScrollMap()[makeLegacyKey(documentScopeKey, pageId, editorSessionKey)];
  if (!isNonNegativeFiniteNumber(legacyScrollTop)) return null;
  const migrated: PageStageViewportSnapshot = {
    version: 2,
    kind: "offset",
    scrollTop: legacyScrollTop,
  };
  memory.remember(key, migrated);
  return migrated;
}

export function forgetPageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  editorSessionKey?: string,
): void {
  const key = makeKey(documentScopeKey, pageId, editorSessionKey);
  memory.forget(key);

  try {
    const legacyMap = readLegacyScrollMap();
    delete legacyMap[makeLegacyKey(documentScopeKey, pageId, editorSessionKey)];
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacyMap));
  } catch {
    // localStorage may be unavailable in restricted renderer contexts.
  }
}
