import { useSyncExternalStore } from "react";
import {
  makeBrowserSidebarConversationScopeKey,
  makeBrowserSidebarTabKey,
  type BrowserSidebarBrowserUseStateSnapshot,
  type BrowserSidebarRuntimeSnapshot,
  type BrowserSidebarStateSnapshot,
  type BrowserUsePageClosedEvent,
  type BrowserUsePresentationRequest,
} from "../../../shared/browser-sidebar";
import { invokeRendererQuery } from "@/lib/renderer-command";

export interface BrowserSidebarRendererState {
  readonly state: BrowserSidebarStateSnapshot;
  readonly browserUseState: BrowserSidebarBrowserUseStateSnapshot;
  readonly presentationRequests: readonly BrowserUsePresentationRequest[];
}

const EMPTY_STATE: BrowserSidebarRendererState = {
  state: { tabs: [] },
  browserUseState: {
    tabs: [],
    activeBrowserTabIdsByConversationScope: {},
    cursors: [],
  },
  presentationRequests: [],
};

let snapshot = EMPTY_STATE;
let stateRevision = 0;
let browserUseRevision = 0;
const listeners = new Set<() => void>();

function publish(next: BrowserSidebarRendererState): void {
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function updateState(state: BrowserSidebarStateSnapshot): void {
  stateRevision += 1;
  publish({ ...snapshot, state });
}

function updateBrowserUseState(browserUseState: BrowserSidebarBrowserUseStateSnapshot): void {
  browserUseRevision += 1;
  publish({ ...snapshot, browserUseState });
}

function removeClosedPage(event: BrowserUsePageClosedEvent): void {
  const tabKey = makeBrowserSidebarTabKey(event);
  const scopeKey = makeBrowserSidebarConversationScopeKey(event);
  const nextState = {
    tabs: snapshot.state.tabs.filter((tab) => makeBrowserSidebarTabKey(tab) !== tabKey),
  };
  const activeBrowserTabIdsByConversationScope = {
    ...snapshot.browserUseState.activeBrowserTabIdsByConversationScope,
  };
  if (activeBrowserTabIdsByConversationScope[scopeKey] === event.browserTabId) {
    delete activeBrowserTabIdsByConversationScope[scopeKey];
  }
  stateRevision += 1;
  browserUseRevision += 1;
  publish({
    state: nextState,
    browserUseState: {
      tabs: snapshot.browserUseState.tabs.filter((tab) => makeBrowserSidebarTabKey(tab) !== tabKey),
      activeBrowserTabIdsByConversationScope,
      cursors: snapshot.browserUseState.cursors.filter(
        (cursor) => makeBrowserSidebarTabKey(cursor) !== tabKey,
      ),
    },
    presentationRequests: snapshot.presentationRequests.filter(
      (request) => makeBrowserSidebarTabKey(request) !== tabKey,
    ),
  });
}

function updatePresentationRequest(request: BrowserUsePresentationRequest): void {
  const tabKey = makeBrowserSidebarTabKey(request);
  publish({
    ...snapshot,
    presentationRequests: [
      ...snapshot.presentationRequests.filter(
        (candidate) => makeBrowserSidebarTabKey(candidate) !== tabKey,
      ),
      request,
    ],
  });
}

export function consumeBrowserUsePresentationRequest(requestId: string): void {
  const presentationRequests = snapshot.presentationRequests.filter(
    (request) => request.requestId !== requestId,
  );
  if (presentationRequests.length === snapshot.presentationRequests.length) {
    return;
  }
  publish({ ...snapshot, presentationRequests });
}

export const browserSidebarRendererStateStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): BrowserSidebarRendererState {
    return snapshot;
  },
};

export function useBrowserSidebarRendererState(): BrowserSidebarRendererState {
  return useSyncExternalStore(
    browserSidebarRendererStateStore.subscribe,
    browserSidebarRendererStateStore.getSnapshot,
    browserSidebarRendererStateStore.getSnapshot,
  );
}

export function startBrowserSidebarRendererStateStore(): () => void {
  if (!window.api) return () => undefined;

  const initialStateRevision = stateRevision;
  const initialBrowserUseRevision = browserUseRevision;
  let disposed = false;
  const unsubscribeState = window.api.on("browser-sidebar-state", (payload) => {
    updateState(payload as BrowserSidebarStateSnapshot);
  });
  const unsubscribeBrowserUse = window.api.on("browser-sidebar-browser-use-state", (payload) => {
    updateBrowserUseState(payload as BrowserSidebarBrowserUseStateSnapshot);
  });
  const unsubscribePageClosed = window.api.on(
    "browser-sidebar-browser-use-page-closed",
    (payload) => {
      removeClosedPage(payload as BrowserUsePageClosedEvent);
    },
  );
  const unsubscribePresentationRequest = window.api.on(
    "browser-sidebar-browser-use-presentation-request",
    (payload) => {
      updatePresentationRequest(payload as BrowserUsePresentationRequest);
    },
  );

  void invokeRendererQuery("browser-sidebar-runtime-snapshot")
    .then((runtimeSnapshot: BrowserSidebarRuntimeSnapshot) => {
      if (disposed) return;
      const next = {
        state: stateRevision === initialStateRevision ? runtimeSnapshot.state : snapshot.state,
        browserUseState:
          browserUseRevision === initialBrowserUseRevision
            ? runtimeSnapshot.browserUseState
            : snapshot.browserUseState,
        presentationRequests: [
          ...snapshot.presentationRequests,
          ...runtimeSnapshot.presentationRequests.filter(
            (request) =>
              !snapshot.presentationRequests.some(
                (candidate) => candidate.requestId === request.requestId,
              ),
          ),
        ],
      };
      publish(next);
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    unsubscribeState?.();
    unsubscribeBrowserUse?.();
    unsubscribePageClosed?.();
    unsubscribePresentationRequest?.();
  };
}

export function resetBrowserSidebarRendererStateStoreForTests(): void {
  stateRevision = 0;
  browserUseRevision = 0;
  snapshot = EMPTY_STATE;
  listeners.clear();
}
