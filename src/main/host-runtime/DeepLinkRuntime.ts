import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  parsePageDeepLink,
  parseSessionDeepLink,
  parseViewDeepLink,
} from "../../shared/nodex-deeplink";
import { safeSendToWindow } from "../ipc-safe-send";
import { LibraryModule } from "../library-application/LibraryModule";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";

interface DeepLinkState {
  readonly ready: boolean;
  readonly pageId: string | null;
  readonly pageTarget: { readonly projectId: string; readonly pageId: string } | null;
  readonly sessionId: string | null;
  readonly sessionTarget: {
    readonly projectId: string | null;
    readonly sessionId: string;
  } | null;
  readonly viewId: string | null;
  readonly viewTarget: { readonly projectId: string; readonly viewId: string } | null;
}

const initialState: DeepLinkState = {
  ready: false,
  pageId: null,
  pageTarget: null,
  sessionId: null,
  sessionTarget: null,
  viewId: null,
  viewTarget: null,
};

export class DeepLinkRuntimeError extends Schema.TaggedError<DeepLinkRuntimeError>()(
  "DeepLinkRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface DeepLinkRuntimeOptions {
  readonly focusWindow: () => void;
  readonly windows: WindowRuntimeService;
}

export class DeepLinkRuntime extends Context.Service<
  DeepLinkRuntime,
  {
    readonly extractFromArgv: (
      argv: readonly string[],
    ) => Effect.Effect<string | null, DeepLinkRuntimeError>;
    readonly flush: Effect.Effect<void>;
    readonly handle: (value: string) => Effect.Effect<boolean, DeepLinkRuntimeError>;
    readonly markReady: Effect.Effect<void, DeepLinkRuntimeError>;
  }
>()("nodex/main/host-runtime/DeepLinkRuntime") {}

export const live = (
  options: DeepLinkRuntimeOptions,
): Layer.Layer<DeepLinkRuntime, never, LibraryModule | ProjectWorkspace> =>
  Layer.effect(
    DeepLinkRuntime,
    Effect.gen(function* () {
      const library = yield* LibraryModule;
      const workspace = yield* ProjectWorkspace;
      const state = yield* Ref.make(initialState);

      const flush = Effect.gen(function* () {
        const targetWindow = options.windows.getLastFocused();
        if (!targetWindow || targetWindow.isDestroyed()) return;
        // A tray action can create a window whose document has loaded before its route owner.
        if (!options.windows.isRendererInitialized(targetWindow.webContents.id)) return;
        if (
          targetWindow.webContents.isDestroyed() ||
          targetWindow.webContents.isLoadingMainFrame()
        ) {
          return;
        }
        const snapshot = yield* Ref.get(state);
        if (
          snapshot.pageTarget &&
          safeSendToWindow(targetWindow, "deeplink:open-page", [snapshot.pageTarget])
        ) {
          yield* Ref.update(state, (current) =>
            current.pageTarget === snapshot.pageTarget ? { ...current, pageTarget: null } : current,
          );
        }
        if (
          snapshot.sessionTarget &&
          safeSendToWindow(targetWindow, "deeplink:open-session", [snapshot.sessionTarget])
        ) {
          yield* Ref.update(state, (current) =>
            current.sessionTarget === snapshot.sessionTarget
              ? { ...current, sessionTarget: null }
              : current,
          );
        }
        if (
          snapshot.viewTarget &&
          safeSendToWindow(targetWindow, "deeplink:open-view", [snapshot.viewTarget])
        ) {
          yield* Ref.update(state, (current) =>
            current.viewTarget === snapshot.viewTarget ? { ...current, viewTarget: null } : current,
          );
        }
      });

      const resolvePage = Effect.gen(function* () {
        const snapshot = yield* Ref.get(state);
        if (!snapshot.ready || !snapshot.pageId) return yield* flush;
        const pageId = snapshot.pageId;
        const location = yield* library
          .findPageLocation(pageId)
          .pipe(
            Effect.mapError(
              (cause) => new DeepLinkRuntimeError({ operation: "resolve-page", cause }),
            ),
          );
        yield* Ref.update(state, (current) =>
          current.pageId !== pageId
            ? current
            : {
                ...current,
                pageId: null,
                pageTarget: location ? { projectId: location.projectId, pageId } : null,
              },
        );
        yield* flush;
      });
      const resolveSession = Effect.gen(function* () {
        const snapshot = yield* Ref.get(state);
        if (!snapshot.ready || !snapshot.sessionId) return yield* flush;
        const sessionId = snapshot.sessionId;
        const session = yield* workspace
          .getProjectSession(sessionId)
          .pipe(
            Effect.mapError(
              (cause) => new DeepLinkRuntimeError({ operation: "resolve-session", cause }),
            ),
          );
        yield* Ref.update(state, (current) =>
          current.sessionId !== sessionId
            ? current
            : {
                ...current,
                sessionId: null,
                sessionTarget: session ? { projectId: session.projectId, sessionId } : null,
              },
        );
        yield* flush;
      });
      const resolveView = Effect.gen(function* () {
        const snapshot = yield* Ref.get(state);
        if (!snapshot.ready || !snapshot.viewId) return yield* flush;
        const viewId = snapshot.viewId;
        const location = yield* library
          .findViewLocation(viewId)
          .pipe(
            Effect.mapError(
              (cause) => new DeepLinkRuntimeError({ operation: "resolve-view", cause }),
            ),
          );
        yield* Ref.update(state, (current) =>
          current.viewId !== viewId
            ? current
            : {
                ...current,
                viewId: null,
                viewTarget: location ? { projectId: location.projectId, viewId } : null,
              },
        );
        yield* flush;
      });

      const queuePage = (pageId: string) =>
        Ref.update(state, (current) => ({ ...current, pageId })).pipe(
          Effect.andThen(Ref.get(state)),
          Effect.flatMap((current) => {
            if (!current.ready) return Effect.void;
            options.focusWindow();
            return resolvePage;
          }),
        );
      const queueSession = (sessionId: string) =>
        Ref.update(state, (current) => ({ ...current, sessionId })).pipe(
          Effect.andThen(Ref.get(state)),
          Effect.flatMap((current) => {
            if (!current.ready) return Effect.void;
            options.focusWindow();
            return resolveSession;
          }),
        );
      const queueView = (viewId: string) =>
        Ref.update(state, (current) => ({ ...current, viewId })).pipe(
          Effect.andThen(Ref.get(state)),
          Effect.flatMap((current) => {
            if (!current.ready) return Effect.void;
            options.focusWindow();
            return resolveView;
          }),
        );
      const handle = (value: string): Effect.Effect<boolean, DeepLinkRuntimeError> => {
        const session = parseSessionDeepLink(value);
        if (session) return queueSession(session.sessionId).pipe(Effect.as(true));
        const view = parseViewDeepLink(value);
        if (view) return queueView(view.viewId).pipe(Effect.as(true));
        const page = parsePageDeepLink(value);
        if (!page) return Effect.succeed(false);
        return queuePage(page.pageId).pipe(Effect.as(true));
      };

      return DeepLinkRuntime.of({
        extractFromArgv: (argv) =>
          Effect.gen(function* () {
            for (const value of argv) {
              if (yield* handle(value)) return value;
            }
            return null;
          }),
        flush,
        handle,
        markReady: Ref.update(state, (current) => ({ ...current, ready: true })).pipe(
          Effect.andThen(
            Effect.all([resolvePage, resolveSession, resolveView], { concurrency: 3 }),
          ),
          Effect.asVoid,
        ),
      });
    }),
  );
