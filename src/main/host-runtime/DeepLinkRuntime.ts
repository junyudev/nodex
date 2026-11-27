import type { MiniOpenTarget } from "../../shared/mini";
import type { InboxScope } from "../../shared/inbox";
import {
  EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL,
  type WorkbenchCommandInvocation,
} from "../../shared/workbench-commands";
import { CoreRequestClass } from "../core-runtime/CoreRequestClass";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  buildPageDeepLink,
  buildSessionDeepLink,
  parsePageDeepLink,
  parseSessionDeepLink,
  parseViewDeepLink,
  type NodexDeepLinkTarget,
  type QualifiedSpaceDeepLink,
} from "../../shared/nodex-deeplink";
import type { IpcEvents } from "../../shared/ipc-api";
import { rendererSpaceParameter } from "../../shared/space-ipc-policy";
import { safeSendToWindow } from "../ipc-safe-send";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";

export class DeepLinkRuntimeError extends Schema.TaggedError<DeepLinkRuntimeError>()(
  "DeepLinkRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface DeepLinkRuntimeOptions {
  readonly focusWindow: () => void;
  readonly focusPersonalWindow?: () => void;
  readonly windows: WindowRuntimeService;
}
interface SpaceLinkResolver {
  readonly personalSpaceId: string;
  readonly resolve: (
    target: NodexDeepLinkTarget & { readonly spaceId: string },
  ) => Effect.Effect<QualifiedSpaceDeepLink | null, DeepLinkRuntimeError>;
}

export class DeepLinkRuntime extends Context.Service<
  DeepLinkRuntime,
  {
    readonly configureSpaces: (
      resolver: SpaceLinkResolver,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly extractFromArgv: (
      argv: readonly string[],
    ) => Effect.Effect<string | null, DeepLinkRuntimeError>;
    readonly flush: Effect.Effect<void>;
    readonly handle: (value: string) => Effect.Effect<boolean, DeepLinkRuntimeError>;
    readonly openMiniTarget: (target: MiniOpenTarget) => Effect.Effect<void, DeepLinkRuntimeError>;
    readonly markReady: Effect.Effect<void, DeepLinkRuntimeError>;
  }
>()("nodex/main/host-runtime/DeepLinkRuntime") {}

/** Resolve against the addressed Space before delivering any navigation to a renderer. */
export const live = (options: DeepLinkRuntimeOptions) =>
  Layer.effect(
    DeepLinkRuntime,
    Effect.gen(function* () {
      const state = yield* Ref.make({
        ready: false,
        pending: [] as NodexDeepLinkTarget[],
        resolved: [] as QualifiedSpaceDeepLink[],
      });
      let pendingInbox: InboxScope | null = null;
      let spaces: SpaceLinkResolver | null = null;
      const fail = (cause: unknown) =>
        new DeepLinkRuntimeError({ operation: "resolve-link", cause });
      const resolve = (
        target: NodexDeepLinkTarget,
      ): Effect.Effect<QualifiedSpaceDeepLink | null, DeepLinkRuntimeError> => {
        if (!target.spaceId)
          return Effect.fail(fail(new Error("A Space-qualified link is required")));
        if (!spaces) return Effect.fail(fail(new Error("Space routing is not ready")));
        return spaces.resolve({ ...target, spaceId: target.spaceId });
      };
      const flush = Effect.gen(function* () {
        const snapshot = yield* Ref.get(state);
        const readyWindow = (spaceId: string, allowOtherSpace: boolean) => {
          const focused = options.windows.getLastFocused();
          const matches = (window: NonNullable<typeof focused>) =>
            (rendererSpaceParameter(window.webContents.getURL?.() ?? "") ??
              spaces?.personalSpaceId) === spaceId;
          const window =
            focused && matches(focused)
              ? focused
              : (options.windows.all().find(matches) ?? (allowOtherSpace ? focused : null));
          if (
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            window.webContents.isLoadingMainFrame() ||
            !options.windows.isRendererInitialized(window.webContents.id)
          )
            return null;
          return window;
        };
        if (pendingInbox && spaces) {
          const inbox = pendingInbox;
          const window = readyWindow(spaces.personalSpaceId, false);
          if (
            safeSendToWindow(window, EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL, [
              {
                commandId: "openInbox",
                source: "toolbar",
                inboxScope: inbox,
              } satisfies WorkbenchCommandInvocation,
            ])
          )
            pendingInbox = null;
        }
        for (const target of snapshot.resolved) {
          const window = readyWindow(target.spaceId, true);
          if (!window) continue;
          const { kind, ...payload } = target;
          const channel = `deeplink:open-${kind}` satisfies keyof IpcEvents;
          if (!safeSendToWindow(window, channel, [payload])) continue;
          yield* Ref.update(state, (current) => ({
            ...current,
            resolved: current.resolved.filter((entry) => entry !== target),
          }));
        }
      });
      const resolvePending = Effect.gen(function* () {
        const snapshot = yield* Ref.get(state);
        if (!snapshot.ready) return;
        for (const target of snapshot.pending) {
          yield* Ref.update(state, (current) => ({
            ...current,
            pending: current.pending.filter((entry) => entry !== target),
          }));
          const resolved = yield* resolve(target).pipe(
            Effect.provideService(CoreRequestClass, "interactive"),
          );
          yield* Ref.update(state, (current) => ({
            ...current,
            resolved: resolved
              ? [...current.resolved.filter((entry) => entry.kind !== target.kind), resolved]
              : current.resolved,
          }));
        }
        yield* flush;
      });
      const handle = (value: string, focusWindow = options.focusWindow) => {
        const page = parsePageDeepLink(value);
        const session = parseSessionDeepLink(value);
        const view = parseViewDeepLink(value);
        const target: NodexDeepLinkTarget | null = page
          ? { ...page, kind: "page" }
          : session
            ? { ...session, kind: "session" }
            : view
              ? { ...view, kind: "view" }
              : null;
        if (!target?.spaceId) return Effect.succeed(false);
        return Ref.update(state, (current) => ({
          ...current,
          pending: [...current.pending.filter((entry) => entry.kind !== target.kind), target],
        })).pipe(
          Effect.andThen(Effect.sync(focusWindow)),
          Effect.andThen(resolvePending),
          Effect.as(true),
        );
      };
      return DeepLinkRuntime.of({
        configureSpaces: (resolver) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              spaces = resolver;
            }),
            () =>
              Effect.sync(() => {
                spaces = null;
              }),
          ),
        extractFromArgv: (argv) =>
          Effect.gen(function* () {
            for (const value of argv) if (yield* handle(value)) return value;
            return null;
          }),
        flush,
        handle,
        openMiniTarget: (target) =>
          Effect.gen(function* () {
            if (!spaces) return yield* fail(new Error("Space routing is not ready"));
            const spaceId = spaces.personalSpaceId;
            const focus = options.focusPersonalWindow ?? options.focusWindow;
            if (target.kind === "inbox") {
              pendingInbox = target.scope;
              yield* Effect.sync(focus);
              return yield* flush;
            }
            const link = yield* Effect.try({
              try: () =>
                target.kind === "page"
                  ? buildPageDeepLink({ pageId: target.pageId, spaceId })
                  : buildSessionDeepLink({ sessionId: target.sessionId, spaceId }),
              catch: fail,
            });
            yield* handle(link, focus);
          }),
        markReady: Ref.update(state, (current) => ({ ...current, ready: true })).pipe(
          Effect.andThen(resolvePending),
        ),
      });
    }),
  );
