import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  parsePageDeepLink,
  parseSessionDeepLink,
  parseViewDeepLink,
  type NodexDeepLinkTarget,
  type ResolvedSpaceDeepLink,
} from "../../shared/nodex-deeplink";
import { rendererSpaceParameter } from "../../shared/space-ipc-policy";
import { safeSendToWindow } from "../ipc-safe-send";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";

export class DeepLinkRuntimeError extends Schema.TaggedError<DeepLinkRuntimeError>()(
  "DeepLinkRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface DeepLinkRuntimeOptions {
  readonly focusWindow: () => void;
  readonly windows: WindowRuntimeService;
}
interface SpaceLinkResolver {
  readonly personalSpaceId: string;
  readonly resolve: (
    target: NodexDeepLinkTarget & { readonly spaceId: string },
  ) => Effect.Effect<ResolvedSpaceDeepLink | null, DeepLinkRuntimeError>;
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
        resolved: [] as ResolvedSpaceDeepLink[],
      });
      let spaces: SpaceLinkResolver | null = null;
      const fail = (cause: unknown) =>
        new DeepLinkRuntimeError({ operation: "resolve-link", cause });
      const resolve = (
        target: NodexDeepLinkTarget,
      ): Effect.Effect<ResolvedSpaceDeepLink | null, DeepLinkRuntimeError> => {
        if (!target.spaceId)
          return Effect.fail(fail(new Error("A Space-qualified link is required")));
        if (!spaces) return Effect.fail(fail(new Error("Space routing is not ready")));
        return spaces.resolve({ ...target, spaceId: target.spaceId });
      };
      const flush = Effect.gen(function* () {
        const snapshot = yield* Ref.get(state);
        for (const target of snapshot.resolved) {
          const focused = options.windows.getLastFocused();
          const matches = (window: NonNullable<typeof focused>) =>
            (rendererSpaceParameter(window.webContents.getURL?.() ?? "") ??
              spaces?.personalSpaceId) === target.spaceId;
          const window =
            focused && matches(focused)
              ? focused
              : (options.windows.all().find(matches) ?? focused);
          if (
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            window.webContents.isLoadingMainFrame() ||
            !options.windows.isRendererInitialized(window.webContents.id)
          )
            continue;
          const { kind, ...payload } = target;
          if (!safeSendToWindow(window, `deeplink:open-${kind}`, [payload])) continue;
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
          const resolved = yield* resolve(target);
          yield* Ref.update(state, (current) => ({
            ...current,
            resolved: resolved
              ? [...current.resolved.filter((entry) => entry.kind !== target.kind), resolved]
              : current.resolved,
          }));
        }
        yield* flush;
      });
      const handle = (value: string) => {
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
          Effect.andThen(Effect.sync(() => options.focusWindow())),
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
        markReady: Ref.update(state, (current) => ({ ...current, ready: true })).pipe(
          Effect.andThen(resolvePending),
        ),
      });
    }),
  );
