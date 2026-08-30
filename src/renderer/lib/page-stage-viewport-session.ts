import { SCROLL_SAVE_DEBOUNCE_MS } from "./timing";
import {
  loadPageStageViewportSnapshot,
  rememberPageStageViewportSnapshot,
  savePageStageViewportSnapshot,
  type PageStageViewportSnapshot,
} from "./page-stage-viewport-storage";

const BLOCK_SELECTOR = ".bn-block[data-id]";
const EDGE_EPSILON_PX = 2;
const LAYOUT_EXTENT_EPSILON_PX = 0.5;
const USER_INTERACTION_SETTLE_MS = 160;
const PROGRAMMATIC_SCROLL_SETTLE_MS = 100;

export interface PageStageViewportIdentity {
  readonly documentScopeKey: string;
  readonly pageId: string;
  readonly editorSessionKey?: string;
}

export interface PageStageViewportLease {
  release(): void;
}

interface MountedViewport {
  readonly scrollElement: HTMLElement;
  readonly contentRoot: HTMLElement;
  readonly layoutRoot: HTMLElement;
}

interface LayoutExtent {
  readonly width: number;
  readonly height: number;
  readonly scrollHeight: number;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function findAnchorElement(
  contentRoot: HTMLElement,
  scrollElement: HTMLElement,
): HTMLElement | null {
  const viewport = scrollElement.getBoundingClientRect();
  const candidates = contentRoot.querySelectorAll<HTMLElement>(BLOCK_SELECTOR);
  let partiallyVisibleCandidate: HTMLElement | null = null;
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom <= viewport.top + EDGE_EPSILON_PX) continue;
    if (rect.top >= viewport.bottom - EDGE_EPSILON_PX) continue;
    partiallyVisibleCandidate ??= candidate;
    if (
      rect.top >= viewport.top - EDGE_EPSILON_PX &&
      rect.bottom <= viewport.bottom + EDGE_EPSILON_PX
    ) {
      return candidate;
    }
  }
  return partiallyVisibleCandidate;
}

function captureSnapshot(viewport: MountedViewport): PageStageViewportSnapshot {
  const { scrollElement, contentRoot } = viewport;
  const scrollTop = Math.max(0, scrollElement.scrollTop);
  if (scrollTop <= EDGE_EPSILON_PX) return { version: 2, kind: "top" };

  const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  const bottomGap = Math.max(0, maxScrollTop - scrollTop);
  if (maxScrollTop > 0 && bottomGap <= EDGE_EPSILON_PX) {
    return { version: 2, kind: "bottom", gapPx: bottomGap };
  }

  const anchor = findAnchorElement(contentRoot, scrollElement);
  if (!anchor) return { version: 2, kind: "offset", scrollTop };

  const viewportRect = scrollElement.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const blockId = anchor.dataset.id;
  if (!blockId) return { version: 2, kind: "offset", scrollTop };

  return {
    version: 2,
    kind: "anchor",
    blockId,
    viewportOffsetPx: anchorRect.top - viewportRect.top,
    fallbackScrollTop: scrollTop,
  };
}

function isUserIntentKey(event: KeyboardEvent): boolean {
  return !["Alt", "Control", "Meta", "Shift"].includes(event.key);
}

function hasMeasurableLayout(viewport: MountedViewport): boolean {
  return (
    viewport.scrollElement.isConnected &&
    viewport.contentRoot.isConnected &&
    viewport.scrollElement.clientHeight > 0 &&
    viewport.scrollElement.getClientRects().length > 0 &&
    viewport.contentRoot.getClientRects().length > 0
  );
}

function readLayoutExtent(viewport: MountedViewport): LayoutExtent {
  const rect = viewport.layoutRoot.getBoundingClientRect();
  return {
    width: rect.width,
    height: rect.height,
    scrollHeight: viewport.scrollElement.scrollHeight,
  };
}

function layoutExtentsEqual(left: LayoutExtent, right: LayoutExtent): boolean {
  return (
    Math.abs(left.width - right.width) <= LAYOUT_EXTENT_EPSILON_PX &&
    Math.abs(left.height - right.height) <= LAYOUT_EXTENT_EPSILON_PX &&
    Math.abs(left.scrollHeight - right.scrollHeight) <= LAYOUT_EXTENT_EPSILON_PX
  );
}

/**
 * PageTab-owned viewport continuity. The mounted DOM is a replaceable capability;
 * this retained session owns the semantic anchor and continuously compensates
 * layout changes from any Block implementation while the user is not navigating.
 */
export class PageStageViewportSession {
  private readonly identity: PageStageViewportIdentity;
  private mounted: MountedViewport | null = null;
  private latestSnapshot: PageStageViewportSnapshot | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private readonly observedBlockElements = new Set<HTMLElement>();
  private restoreFrame: number | null = null;
  private interactionTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreGeneration = 0;
  private mountGeneration = 0;
  private programmaticScrollSettledAt = 0;
  private userInteractionActive = false;
  private layoutChangePending = false;
  private lastLayoutExtent: LayoutExtent | null = null;
  private disposed = false;

  constructor(identity: PageStageViewportIdentity) {
    this.identity = identity;
  }

  mount(scrollElement: HTMLElement, contentRoot: HTMLElement): PageStageViewportLease {
    if (this.disposed) throw new Error("Cannot mount a disposed Page Stage viewport session");

    this.unmount();
    const mountGeneration = ++this.mountGeneration;
    const layoutRoot =
      scrollElement.querySelector<HTMLElement>('[data-page-stage-body="true"]') ?? contentRoot;
    this.mounted = { scrollElement, contentRoot, layoutRoot };
    scrollElement.addEventListener("scroll", this.handleScroll, { passive: true });
    scrollElement.addEventListener("wheel", this.handleUserIntent, { passive: true });
    scrollElement.addEventListener("pointerdown", this.handleUserIntent, { passive: true });
    scrollElement.addEventListener("touchstart", this.handleUserIntent, { passive: true });
    scrollElement.addEventListener("keydown", this.handleKeyDown);
    contentRoot.addEventListener("load", this.handleLayoutSignal, true);
    contentRoot.addEventListener("error", this.handleLayoutSignal, true);

    this.latestSnapshot = this.latestSnapshot ??
      loadPageStageViewportSnapshot(
        this.identity.documentScopeKey,
        this.identity.pageId,
        this.identity.editorSessionKey,
      ) ?? { version: 2, kind: "top" };

    this.startLayoutObservation();
    this.applySnapshot(this.latestSnapshot);
    this.lastLayoutExtent = readLayoutExtent(this.mounted);
    this.handleLayoutSignal();
    return {
      release: () => {
        if (this.mountGeneration !== mountGeneration) return;
        this.unmount();
      },
    };
  }

  unmount(): void {
    const mounted = this.mounted;
    if (!mounted) return;
    this.mountGeneration += 1;

    // Teardown order is not a measurement boundary: React or ProseMirror may
    // already have collapsed the DOM. Persist the last observed anchor instead.
    this.persist();
    this.stopLayoutObservation();
    this.clearInteractionTimer();
    mounted.scrollElement.removeEventListener("scroll", this.handleScroll);
    mounted.scrollElement.removeEventListener("wheel", this.handleUserIntent);
    mounted.scrollElement.removeEventListener("pointerdown", this.handleUserIntent);
    mounted.scrollElement.removeEventListener("touchstart", this.handleUserIntent);
    mounted.scrollElement.removeEventListener("keydown", this.handleKeyDown);
    mounted.contentRoot.removeEventListener("load", this.handleLayoutSignal, true);
    mounted.contentRoot.removeEventListener("error", this.handleLayoutSignal, true);
    this.mounted = null;
    this.userInteractionActive = false;
    this.layoutChangePending = false;
    this.lastLayoutExtent = null;
    this.programmaticScrollSettledAt = 0;
  }

  persist(): void {
    this.clearSaveTimer();
    if (!this.latestSnapshot) return;
    savePageStageViewportSnapshot(
      this.identity.documentScopeKey,
      this.identity.pageId,
      this.latestSnapshot,
      this.identity.editorSessionKey,
    );
  }

  /** Makes an explicit in-app jump the new semantic reading position. */
  adoptCurrentViewport(): void {
    if (!this.mounted) return;
    this.clearInteractionTimer();
    this.cancelScheduledRestore();
    this.userInteractionActive = false;
    this.programmaticScrollSettledAt = 0;
    if (!this.captureCurrentViewport()) return;
    this.layoutChangePending = false;
    this.lastLayoutExtent = readLayoutExtent(this.mounted);
  }

  dispose(): void {
    if (this.disposed) return;
    this.unmount();
    this.disposed = true;
  }

  private readonly handleScroll = () => {
    const mounted = this.mounted;
    if (!mounted) return;
    if (!this.userInteractionActive && now() < this.programmaticScrollSettledAt) return;

    if (!this.userInteractionActive && this.hasUncompensatedLayoutChange()) {
      this.handleLayoutSignal();
      return;
    }

    this.captureCurrentViewport();
    if (this.userInteractionActive) this.scheduleInteractionSettle();
  };

  private readonly handleUserIntent = () => {
    this.userInteractionActive = true;
    this.programmaticScrollSettledAt = 0;
    this.cancelScheduledRestore();
    this.scheduleInteractionSettle();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (isUserIntentKey(event)) this.handleUserIntent();
  };

  private readonly handleLayoutSignal = () => {
    if (!this.mounted) return;
    this.layoutChangePending = true;
    if (this.userInteractionActive) return;
    this.scheduleRestore();
  };

  private readonly handleMutations = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of record.removedNodes) this.unobserveBlocksIn(node);
      for (const node of record.addedNodes) this.observeBlocksIn(node);
    }
    this.handleLayoutSignal();
  };

  private captureCurrentViewport(): boolean {
    const mounted = this.mounted;
    if (!mounted || !hasMeasurableLayout(mounted)) return false;
    this.latestSnapshot = captureSnapshot(mounted);
    rememberPageStageViewportSnapshot(
      this.identity.documentScopeKey,
      this.identity.pageId,
      this.latestSnapshot,
      this.identity.editorSessionKey,
    );
    this.scheduleSave();
    return true;
  }

  private applySnapshot(snapshot: PageStageViewportSnapshot): void {
    const mounted = this.mounted;
    if (!mounted || !hasMeasurableLayout(mounted)) return;
    const { scrollElement, contentRoot } = mounted;

    if (snapshot.kind === "top") {
      this.writeScrollTop(0);
      return;
    }
    if (snapshot.kind === "bottom") {
      const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      this.writeScrollTop(Math.max(0, maxScrollTop - snapshot.gapPx));
      return;
    }
    if (snapshot.kind === "offset") {
      this.writeScrollTop(snapshot.scrollTop);
      return;
    }

    const escapedBlockId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(snapshot.blockId)
        : snapshot.blockId.replace(/["\\]/gu, "\\$&");
    const anchor = contentRoot.querySelector<HTMLElement>(`.bn-block[data-id="${escapedBlockId}"]`);
    if (!anchor) {
      this.writeScrollTop(snapshot.fallbackScrollTop);
      return;
    }

    const viewportRect = scrollElement.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const currentOffset = anchorRect.top - viewportRect.top;
    this.writeScrollTop(scrollElement.scrollTop + currentOffset - snapshot.viewportOffsetPx);
  }

  private writeScrollTop(value: number): void {
    const scrollElement = this.mounted?.scrollElement;
    if (!scrollElement) return;
    this.programmaticScrollSettledAt = now() + PROGRAMMATIC_SCROLL_SETTLE_MS;
    scrollElement.scrollTop = Math.max(0, value);
  }

  private startLayoutObservation(): void {
    const mounted = this.mounted;
    if (!mounted) return;

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.handleLayoutSignal);
      this.resizeObserver.observe(mounted.layoutRoot);
      if (mounted.contentRoot !== mounted.layoutRoot) {
        this.resizeObserver.observe(mounted.contentRoot);
      }
      this.observeBlocksIn(mounted.contentRoot);
    }
    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(this.handleMutations);
      this.mutationObserver.observe(mounted.contentRoot, {
        childList: true,
        subtree: true,
      });
    }
  }

  private observeBlocksIn(node: Node): void {
    if (!this.resizeObserver || !(node instanceof Element)) return;
    const candidates = node.matches(BLOCK_SELECTOR)
      ? [node, ...node.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)]
      : [...node.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || this.observedBlockElements.has(candidate))
        continue;
      this.observedBlockElements.add(candidate);
      this.resizeObserver.observe(candidate);
    }
  }

  private unobserveBlocksIn(node: Node): void {
    if (!this.resizeObserver || !(node instanceof Element)) return;
    const candidates = node.matches(BLOCK_SELECTOR)
      ? [node, ...node.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)]
      : [...node.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)];
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || !this.observedBlockElements.delete(candidate)) {
        continue;
      }
      this.resizeObserver.unobserve(candidate);
    }
  }

  private scheduleRestore(): void {
    if (!this.mounted || !this.latestSnapshot || this.restoreFrame !== null) return;
    const generation = this.restoreGeneration;
    this.restoreFrame = requestAnimationFrame(() => {
      this.restoreFrame = null;
      if (
        generation !== this.restoreGeneration ||
        this.userInteractionActive ||
        !this.mounted ||
        !this.latestSnapshot
      ) {
        return;
      }
      this.applySnapshot(this.latestSnapshot);
      this.layoutChangePending = false;
      this.lastLayoutExtent = readLayoutExtent(this.mounted);
    });
  }

  private scheduleInteractionSettle(): void {
    this.clearInteractionTimer();
    this.interactionTimer = setTimeout(() => {
      this.interactionTimer = null;
      this.userInteractionActive = false;
      if (this.captureCurrentViewport() && this.mounted) {
        this.layoutChangePending = false;
        this.lastLayoutExtent = readLayoutExtent(this.mounted);
        return;
      }
      if (this.layoutChangePending) this.scheduleRestore();
    }, USER_INTERACTION_SETTLE_MS);
  }

  private hasUncompensatedLayoutChange(): boolean {
    const mounted = this.mounted;
    if (!mounted || this.layoutChangePending || !this.lastLayoutExtent) return true;
    return !layoutExtentsEqual(this.lastLayoutExtent, readLayoutExtent(mounted));
  }

  private scheduleSave(): void {
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, SCROLL_SAVE_DEBOUNCE_MS);
  }

  private cancelScheduledRestore(): void {
    this.restoreGeneration += 1;
    if (this.restoreFrame !== null) cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = null;
  }

  private stopLayoutObservation(): void {
    this.cancelScheduledRestore();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedBlockElements.clear();
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
  }

  private clearInteractionTimer(): void {
    if (!this.interactionTimer) return;
    clearTimeout(this.interactionTimer);
    this.interactionTimer = null;
  }

  private clearSaveTimer(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
}
