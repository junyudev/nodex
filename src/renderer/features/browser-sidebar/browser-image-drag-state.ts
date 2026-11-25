import type {
  BrowserSidebarImageDragStateEvent,
  BrowserSidebarTabIdentity,
} from "../../../shared/browser-sidebar";

export interface BrowserImageDragIntent extends BrowserSidebarTabIdentity {
  attachmentConversationId: string;
  dragToken: string;
}

let activeDrag: BrowserImageDragIntent | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function publishBrowserImageDragState(
  attachmentConversationId: string,
  event: BrowserSidebarImageDragStateEvent,
): void {
  if (!attachmentConversationId || !event.isActive) return;
  activeDrag = {
    attachmentConversationId,
    dragToken: event.dragToken,
    browserConversationId: event.browserConversationId,
    browserViewScopeId: event.browserViewScopeId,
    browserTabId: event.browserTabId,
  };
  notify();
}

export function clearBrowserImageDragState(dragToken: string): void {
  if (activeDrag?.dragToken !== dragToken) return;
  activeDrag = null;
  notify();
}

export function getBrowserImageDragSnapshot(
  attachmentConversationId: string,
): BrowserImageDragIntent | null {
  return activeDrag?.attachmentConversationId === attachmentConversationId ? activeDrag : null;
}

export function subscribeBrowserImageDragState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
