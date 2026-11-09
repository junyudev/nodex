import type { ActivityFilter } from "../../../shared/inbox";
import type { InboxView } from "@/lib/inbox-entry-navigation";
import { createViewportMemory, findViewportAnchor } from "@/lib/viewport-memory";

export type { InboxView };

/** Within this distance of the bottom, the Inbox follows new messages like a conversation. */
export const INBOX_STICK_TO_BOTTOM_PX = 160;
const EDGE_EPSILON_PX = 2;

export const ACTIVITY_FILTERS = [
  "all",
  "messages",
  "decisions",
  "problems",
] as const satisfies readonly ActivityFilter[];

/** What a view's place is anchored to: a message in the Inbox, a fact in Activity. */
const ANCHOR_ATTRIBUTE = {
  inbox: "data-inbox-page-id",
  activity: "data-activity-id",
} as const satisfies Record<InboxView, string>;

/**
 * Where a reader is in one view. `latest` follows the live edge: the bottom of the Inbox, which
 * reads oldest first, and the top of Activity, which reads newest first. Otherwise the place is
 * the row at the top of the viewport, so it survives rows being handled or loaded around it.
 */
export type InboxViewportPosition =
  | { readonly kind: "latest" }
  | { readonly kind: "anchor"; readonly id: string; readonly offsetPx: number };

/** One Inbox's place: the view the reader was in, Activity's filter, and where they were. */
export interface InboxViewport {
  readonly view: InboxView;
  readonly activityFilter: ActivityFilter;
  readonly positions: Partial<Record<InboxView, InboxViewportPosition>>;
}

const isView = (value: unknown): value is InboxView => value === "inbox" || value === "activity";
const isActivityFilter = (value: unknown): value is ActivityFilter =>
  ACTIVITY_FILTERS.some((filter) => filter === value);

const decodePosition = (value: unknown): InboxViewportPosition | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "latest") return { kind: "latest" };
  return candidate.kind === "anchor" &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.offsetPx === "number" &&
    Number.isFinite(candidate.offsetPx)
    ? { kind: "anchor", id: candidate.id, offsetPx: candidate.offsetPx }
    : null;
};

const decodeViewport = (value: unknown): InboxViewport | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    !isView(candidate.view) ||
    !isActivityFilter(candidate.activityFilter) ||
    !candidate.positions ||
    typeof candidate.positions !== "object"
  ) {
    return null;
  }
  const positions: Partial<Record<InboxView, InboxViewportPosition>> = {};
  for (const [view, position] of Object.entries(candidate.positions)) {
    const decoded = isView(view) ? decodePosition(position) : null;
    if (decoded && isView(view)) positions[view] = decoded;
  }
  return { view: candidate.view, activityFilter: candidate.activityFilter, positions };
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
  place: { readonly view: InboxView; readonly activityFilter: ActivityFilter },
  position: InboxViewportPosition | null,
  persist: boolean,
): void {
  const current = readInboxViewport(scopeKey);
  const next: InboxViewport = {
    ...place,
    positions: position
      ? { ...current?.positions, [place.view]: position }
      : (current?.positions ?? {}),
  };
  if (persist) memory.save(memoryKey(scopeKey), next);
  else memory.remember(memoryKey(scopeKey), next);
}

/** Reads where the reader is in a view of the stream `scroller` shows. */
export function captureInboxViewportPosition(
  scroller: HTMLElement,
  view: InboxView,
): InboxViewportPosition {
  const atLatest =
    view === "inbox"
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
        INBOX_STICK_TO_BOTTOM_PX
      : scroller.scrollTop <= EDGE_EPSILON_PX;
  if (atLatest) return { kind: "latest" };
  const attribute = ANCHOR_ATTRIBUTE[view];
  const anchor = findViewportAnchor(
    scroller,
    scroller.querySelectorAll<HTMLElement>(`[${attribute}]`),
  );
  const id = anchor?.getAttribute(attribute);
  if (!anchor || !id) return { kind: "latest" };
  return {
    kind: "anchor",
    id,
    offsetPx: anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
  };
}

/**
 * Returns the reader to a place. An anchor that is not rendered reports `false`, so the caller
 * can load earlier rows or settle for the latest.
 */
export function restoreInboxViewportPosition(
  scroller: HTMLElement,
  view: InboxView,
  position: InboxViewportPosition,
): boolean {
  if (position.kind === "latest") {
    scroller.scrollTop = view === "inbox" ? scroller.scrollHeight : 0;
    return true;
  }
  const anchor = scroller.querySelector<HTMLElement>(
    `[${ANCHOR_ATTRIBUTE[view]}="${CSS.escape(position.id)}"]`,
  );
  if (!anchor) return false;
  scroller.scrollTop +=
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.offsetPx;
  return true;
}
