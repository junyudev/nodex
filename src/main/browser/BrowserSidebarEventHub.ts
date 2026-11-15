import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  BrowserSidebarBrowserUseCaptureSurfaceEvent,
  BrowserSidebarBrowserUseStateSnapshot,
  BrowserSidebarBrowserUseViewportEvent,
  BrowserSidebarContextMenuActionEvent,
  BrowserSidebarDestroyWebviewRequest,
  BrowserSidebarImageDragStateEvent,
  BrowserSidebarOpenNewTabRequest,
  BrowserSidebarOpenSurfaceRequest,
  BrowserSidebarStateSnapshot,
  BrowserSidebarTabIdentity,
  BrowserSidebarWebviewAttached,
  BrowserUseCursorState,
  BrowserUsePageClosedEvent,
  BrowserUsePresentationRequest,
} from "../../shared/browser-sidebar";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export type BrowserSidebarEvent =
  | { readonly kind: "state"; readonly value: BrowserSidebarStateSnapshot }
  | { readonly kind: "browserUseState"; readonly value: BrowserSidebarBrowserUseStateSnapshot }
  | { readonly kind: "browserUseViewport"; readonly value: BrowserSidebarBrowserUseViewportEvent }
  | {
      readonly kind: "browserUseCaptureSurface";
      readonly value: BrowserSidebarBrowserUseCaptureSurfaceEvent;
    }
  | { readonly kind: "browserUseCursor"; readonly value: BrowserUseCursorState }
  | {
      readonly kind: "browserUseCursorArrived";
      readonly value: {
        readonly browserConversationId: string;
        readonly browserViewScopeId: string;
        readonly browserTabId: string;
        readonly moveSequence: number;
        readonly ownerWebContentsId: number | null;
      };
    }
  | { readonly kind: "pageReleased"; readonly value: BrowserSidebarTabIdentity }
  | { readonly kind: "pageClosed"; readonly value: BrowserUsePageClosedEvent }
  | {
      readonly kind: "browserUsePresentationRequest";
      readonly value: BrowserUsePresentationRequest;
    }
  | { readonly kind: "contextMenuAction"; readonly value: BrowserSidebarContextMenuActionEvent }
  | { readonly kind: "openNewTab"; readonly value: BrowserSidebarOpenNewTabRequest }
  | { readonly kind: "openSurface"; readonly value: BrowserSidebarOpenSurfaceRequest }
  | { readonly kind: "webviewAttached"; readonly value: BrowserSidebarWebviewAttached }
  | { readonly kind: "destroyWebview"; readonly value: BrowserSidebarDestroyWebviewRequest }
  | {
      readonly kind: "browserUseOwnerReleased";
      readonly value: { readonly ownerWebContentsId: number };
    }
  | { readonly kind: "imageDragState"; readonly value: BrowserSidebarImageDragStateEvent };

export interface BrowserSidebarEventPublisher {
  readonly publish: (event: BrowserSidebarEvent) => void;
}

export interface BrowserSidebarEventHubService extends BrowserSidebarEventPublisher {
  readonly events: Stream.Stream<BrowserSidebarEvent>;
  /** Synchronous seam required by the IAB page-attachment Promise adapter. */
  readonly subscribeWebviewAttached: (
    listener: (value: BrowserSidebarWebviewAttached) => void,
  ) => () => void;
}

/** Owns Browser Sidebar projections and the one exact synchronous IAB adapter subscription. */
export const make: Effect.Effect<BrowserSidebarEventHubService, never, Scope.Scope> = Effect.gen(
  function* () {
    let accepting = true;
    const events = yield* PubSub.sliding<BrowserSidebarEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
    const webviewAttachedSubscribers = new Set<(value: BrowserSidebarWebviewAttached) => void>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        accepting = false;
        webviewAttachedSubscribers.clear();
      }).pipe(Effect.andThen(PubSub.shutdown(events)), Effect.asVoid),
    );

    return {
      events: Stream.fromPubSub(events),
      publish: (event) => {
        if (!accepting) return;
        PubSub.publishUnsafe(events, event);
        if (event.kind !== "webviewAttached") return;
        for (const listener of [...webviewAttachedSubscribers]) {
          listener(event.value);
        }
      },
      subscribeWebviewAttached: (listener) => {
        if (!accepting) return () => undefined;
        webviewAttachedSubscribers.add(listener);
        return () => webviewAttachedSubscribers.delete(listener);
      },
    };
  },
);
