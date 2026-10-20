import type { InboxWindowFilter } from "../../../shared/inbox";
import { createViewportMemory, findViewportAnchor } from "@/lib/viewport-memory";

/** Within this distance of the bottom, the Inbox follows new messages like a conversation. */
export const INBOX_STICK_TO_BOTTOM_PX = 160;
const EDGE_EPSILON_PX = 2;
const MESSAGE_SELECTOR = "[data-inbox-page-id]";

/**
 * Where a reader is in one view. `latest` follows the live edge: the bottom of the Inbox, which
 * reads oldest first, and the top of History, which reads newest first. Otherwise the place is the
 * message at the top of the viewport, so it survives messages being handled or loaded around it.
 */
export type InboxViewportPosition =
  | { readonly kind: "latest" }
  | { readonly kind: "message"; readonly pageId: string; readonly offsetPx: number };

/** One Inbox's place: the view the reader was in and where they were in each view. */
export interface InboxViewport {
  readonly view: InboxWindowFilter;
  readonly positions: Partial<Record<InboxWindowFilter, InboxViewportPosition>>;
}

const isView = (value: unknown): value is InboxWindowFilter =>
  value === "inbox" || value === "processed";

const decodePosition = (value: unknown): InboxViewportPosition | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "latest") return { kind: "latest" };
  return candidate.kind === "message" &&
    typeof candidate.pageId === "string" &&
    candidate.pageId.length > 0 &&
    typeof candidate.offsetPx === "number" &&
    Number.isFinite(candidate.offsetPx)
    ? { kind: "message", pageId: candidate.pageId, offsetPx: candidate.offsetPx }
    : null;
};

const decodeViewport = (value: unknown): InboxViewport | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!isView(candidate.view) || !candidate.positions || typeof candidate.positions !== "object") {
    return null;
  }
  const positions: Partial<Record<InboxWindowFilter, InboxViewportPosition>> = {};
  for (const [view, position] of Object.entries(candidate.positions)) {
    const decoded = isView(view) ? decodePosition(position) : null;
    if (decoded && isView(view)) positions[view] = decoded;
  }
  return { view: candidate.view, positions };
};

const memory = createViewportMemory({
  storageKey: "nodex-inbox-viewport-v1",
  decode: decodeViewport,
});

const memoryKey = (scopeKey: string) => `inbox:${scopeKey}`;

export const readInboxViewport = (scopeKey: string): InboxViewport | null =>
  memory.load(memoryKey(scopeKey));

/** Records the reader's place: in this window at once, across launches when `persist` is set. */
export function recordInboxViewport(
  scopeKey: string,
  view: InboxWindowFilter,
  position: InboxViewportPosition | null,
  persist: boolean,
): void {
  const current = readInboxViewport(scopeKey);
  const next: InboxViewport = {
    view,
    positions: position ? { ...current?.positions, [view]: position } : (current?.positions ?? {}),
  };
  if (persist) memory.save(memoryKey(scopeKey), next);
  else memory.remember(memoryKey(scopeKey), next);
}

/** Reads where the reader is in a view of the stream `scroller` shows. */
export function captureInboxViewportPosition(
  scroller: HTMLElement,
  view: InboxWindowFilter,
): InboxViewportPosition {
  const atLatest =
    view === "inbox"
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
        INBOX_STICK_TO_BOTTOM_PX
      : scroller.scrollTop <= EDGE_EPSILON_PX;
  if (atLatest) return { kind: "latest" };
  const anchor = findViewportAnchor(
    scroller,
    scroller.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR),
  );
  const pageId = anchor?.dataset.inboxPageId;
  if (!anchor || !pageId) return { kind: "latest" };
  return {
    kind: "message",
    pageId,
    offsetPx: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
  };
}

/**
 * Returns the reader to a place. A message place that is not rendered reports `false`, so the
 * caller can load earlier messages or settle for the latest.
 */
export function restoreInboxViewportPosition(
  scroller: HTMLElement,
  view: InboxWindowFilter,
  position: InboxViewportPosition,
): boolean {
  if (position.kind === "latest") {
    scroller.scrollTop = view === "inbox" ? scroller.scrollHeight : 0;
    return true;
  }
  const message = scroller.querySelector<HTMLElement>(
    `[data-inbox-page-id="${CSS.escape(position.pageId)}"]`,
  );
  if (!message) return false;
  scroller.scrollTop +=
    message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offsetPx;
  return true;
}
