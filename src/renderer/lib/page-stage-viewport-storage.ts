import { createViewportMemory } from "./viewport-memory";

const STORAGE_KEY = "nodex-page-stage-viewport-v2";
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

function makeKey(documentScopeKey: string, pageId: string, editorSessionKey?: string): string {
  if (editorSessionKey) return `page-stage-session:${editorSessionKey}`;
  return `page-stage:${documentScopeKey}:${pageId}`;
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
  return memory.load(makeKey(documentScopeKey, pageId, editorSessionKey));
}

export function forgetPageStageViewportSnapshot(
  documentScopeKey: string,
  pageId: string,
  editorSessionKey?: string,
): void {
  memory.forget(makeKey(documentScopeKey, pageId, editorSessionKey));
}
