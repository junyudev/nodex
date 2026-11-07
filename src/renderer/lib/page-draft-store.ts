import type { PageInput } from "./types";

export type PageDraftOverlay = Pick<Partial<PageInput>, "title" | "assignee">;

type StoreListener = () => void;

const EMPTY_PAGE_DRAFT: PageDraftOverlay = Object.freeze({});

function buildDraftKey(projectId: string, pageId: string): string {
  return JSON.stringify([projectId, pageId]);
}

function normalizeDraftOverlay(overlay: PageDraftOverlay): PageDraftOverlay {
  const next: PageDraftOverlay = {};

  if (typeof overlay.title === "string") next.title = overlay.title;
  if (typeof overlay.assignee === "string") next.assignee = overlay.assignee;

  return next;
}

function hasDraftOverlay(overlay: PageDraftOverlay): boolean {
  return Object.keys(overlay).length > 0;
}

function areDraftOverlaysEqual(left: PageDraftOverlay, right: PageDraftOverlay): boolean {
  return left.title === right.title && left.assignee === right.assignee;
}

class PageDraftStore {
  private readonly overlays = new Map<string, PageDraftOverlay>();

  private readonly listeners = new Map<string, Set<StoreListener>>();

  get(projectId: string, pageId: string): PageDraftOverlay {
    return this.overlays.get(buildDraftKey(projectId, pageId)) ?? EMPTY_PAGE_DRAFT;
  }

  set(projectId: string, pageId: string, overlay: PageDraftOverlay): void {
    const key = buildDraftKey(projectId, pageId);
    const normalized = normalizeDraftOverlay(overlay);
    const previous = this.overlays.get(key) ?? EMPTY_PAGE_DRAFT;

    if (!hasDraftOverlay(normalized)) {
      if (previous === EMPTY_PAGE_DRAFT) return;
      this.overlays.delete(key);
      this.emit(key);
      return;
    }

    if (areDraftOverlaysEqual(previous, normalized)) return;
    this.overlays.set(key, normalized);
    this.emit(key);
  }

  clear(projectId: string, pageId: string): void {
    const key = buildDraftKey(projectId, pageId);
    if (!this.overlays.has(key)) return;
    this.overlays.delete(key);
    this.emit(key);
  }

  subscribe(projectId: string, pageId: string, listener: StoreListener): () => void {
    const key = buildDraftKey(projectId, pageId);
    const listeners = this.listeners.get(key) ?? new Set<StoreListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);

    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  reset(): void {
    this.overlays.clear();
    this.listeners.clear();
  }

  private emit(key: string): void {
    const listeners = this.listeners.get(key);
    if (!listeners) return;

    for (const listener of listeners) {
      listener();
    }
  }
}

const pageDraftStore = new PageDraftStore();

export function setPageDraftOverlay(
  projectId: string,
  pageId: string,
  overlay: PageDraftOverlay,
): void {
  if (projectId.length === 0 || pageId.length === 0) return;
  pageDraftStore.set(projectId, pageId, overlay);
}

export function clearPageDraftOverlay(projectId: string, pageId: string): void {
  if (projectId.length === 0 || pageId.length === 0) return;
  pageDraftStore.clear(projectId, pageId);
}

export function getPageDraftOverlay(projectId: string, pageId: string): PageDraftOverlay | null {
  if (projectId.length === 0 || pageId.length === 0) return null;
  const overlay = pageDraftStore.get(projectId, pageId);
  return overlay === EMPTY_PAGE_DRAFT ? null : overlay;
}

export function mergePageDraftOverlay<T extends object>(
  value: T | null | undefined,
  overlay: PageDraftOverlay | null | undefined,
): T | null {
  if (!value) return null;
  if (!overlay || !hasDraftOverlay(overlay)) return value;
  return {
    ...value,
    ...overlay,
  };
}

export function resetPageDraftStoreForTest(): void {
  pageDraftStore.reset();
}
