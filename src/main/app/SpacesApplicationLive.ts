import {
  parsePageDeepLink,
  parseViewDeepLink,
  parseSessionDeepLink,
} from "../../shared/nodex-deeplink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as FiberMap from "effect/FiberMap";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import { DeepLinkRuntime, DeepLinkRuntimeError } from "../host-runtime/DeepLinkRuntime";
import { LibraryModule } from "../library-application/LibraryModule";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { MainConfig } from "./MainConfig";
import {
  SpaceConnectionRegistry,
  live as registryLive,
} from "../space-connections/SpaceConnectionRegistry";
import { live as storageLive } from "../space-connections/SpaceConnectionStorage";
import * as RemoteSpaceDesktop from "../space-connections/RemoteSpaceDesktop";
import * as SecretEncryption from "../platform/electron/SecretEncryption";
import { ElectronIpc, ElectronSpaceIpc } from "../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../platform/electron/TrustedRendererSender";
import { safeBroadcastToWindows } from "../ipc-safe-send";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { personalStateKeyMatches } from "../../shared/space-personal-state";
import { DEVICE_CAPABILITY_CHANNELS, rendererSpaceParameter } from "../../shared/space-ipc-policy";
import { CoreRuntimeError, coreRuntimeError } from "../core-runtime/CoreRuntimeError";

const registry = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return registryLive({ buildId: `nodex-desktop/${config.appVersion}` }).pipe(
      Layer.provide(storageLive(config.nodexHome).pipe(Layer.provide(SecretEncryption.live))),
    );
  }),
);

/** One desktop catalog, with a separately acquired content graph for every remote Space. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const spaces = yield* SpaceConnectionRegistry;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const ipc = yield* ElectronIpc;
    const routing = yield* ElectronSpaceIpc;
    const links = yield* DeepLinkRuntime;
    const personalLibrary = yield* LibraryModule;
    const personalProjects = yield* ProjectWorkspace;
    const desktops = yield* LayerMap.make(
      (spaceId: string): ReturnType<typeof RemoteSpaceDesktop.live> =>
        Layer.fresh(RemoteSpaceDesktop.live(spaceId)).pipe(
          Layer.tapError((error) =>
            Schema.is(CoreRuntimeError)(error) && error.retryable
              ? desktops.invalidate(spaceId)
              : Effect.void,
          ),
        ),
      {
        idleTimeToLive: Infinity,
      },
    );
    yield* links.configureSpaces({
      personalSpaceId: spaces.personalSpaceId,
      resolve: (target) =>
        Effect.gen(function* () {
          const remote =
            target.spaceId === spaces.personalSpaceId
              ? null
              : Context.get(
                  yield* Effect.scoped(desktops.contextEffect(target.spaceId)),
                  RemoteSpaceDesktop.RemoteSpaceDesktop,
                );
          const library = remote?.library ?? personalLibrary;
          const projects = remote?.projects ?? personalProjects;
          if (target.kind === "page") {
            const location = yield* library.findPageLocation(target.pageId);
            return location ? { ...target, projectId: location.projectId } : null;
          }
          if (target.kind === "view") {
            const location = yield* library.findViewLocation(target.viewId);
            return location ? { ...target, projectId: location.projectId } : null;
          }
          const session = yield* projects.getProjectSession(target.sessionId);
          return session ? { ...target, projectId: session.projectId } : null;
        }).pipe(
          Effect.mapError(
            (cause) => new DeepLinkRuntimeError({ operation: "space.resolve-link", cause }),
          ),
        ),
    });
    const observers = yield* FiberMap.make<string>();
    const tracked = new Set<string>();
    const authorize = (event: Electron.IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Space connections", config.rendererUrl);
          if (!windows.has(event.sender.id))
            throw new Error("Space connections require an active application window");
        },
        catch: () => new Error("Space connections require an active application window"),
      });
    const contextFor = (event: Electron.IpcMainInvokeEvent) =>
      authorize(event).pipe(
        Effect.andThen(SubscriptionRef.get(spaces.summaries)),
        Effect.map((entries) => {
          const spaceId =
            rendererSpaceParameter(event.senderFrame?.url ?? "") ?? spaces.personalSpaceId;
          const space = entries.find((entry) => entry.spaceId === spaceId);
          if (!space) throw new Error("This Space is no longer connected");
          return space;
        }),
      );

    yield* routing.configure(({ channel, event, request, personal }) =>
      Effect.gen(function* () {
        const senderSpace = yield* contextFor(event);
        const bound = yield* spaces.validateRequest(request, senderSpace.spaceId);
        if (channel.startsWith("persisted-atom:")) {
          if (channel === "persisted-atom:update") {
            const mutation = bound.args[0];
            if (
              !mutation ||
              typeof mutation !== "object" ||
              !("key" in mutation) ||
              typeof mutation.key !== "string" ||
              !personalStateKeyMatches(mutation.key, bound.spaceId, senderSpace.memberId)
            )
              return yield* Effect.fail(
                new Error("Personal state belongs to another Space or Member"),
              );
          }
          return yield* personal(bound.args);
        }
        if (DEVICE_CAPABILITY_CHANNELS.includes(channel)) return yield* personal(bound.args);
        if (bound.spaceId === spaces.personalSpaceId) return yield* personal(bound.args);
        const context = yield* Effect.scoped(desktops.contextEffect(bound.spaceId));
        return yield* Context.get(context, RemoteSpaceDesktop.RemoteSpaceDesktop).invoke(
          channel,
          event,
          bound.args,
        );
      }),
    );
    yield* ipc.handleQuery("spaces:context", (event) =>
      authorize(event).pipe(
        Effect.andThen(SubscriptionRef.get(spaces.summaries)),
        Effect.map((entries) => {
          const spaceId =
            rendererSpaceParameter(event.senderFrame?.url ?? "") ?? spaces.personalSpaceId;
          return (
            entries.find((entry) => entry.spaceId === spaceId) ?? {
              spaceId,
              kind: "team" as const,
              memberId: null,
              name: "Space",
              availability: "unavailable" as const,
            }
          );
        }),
      ),
    );
    yield* ipc.handleQuery("spaces:list", (event) =>
      authorize(event).pipe(
        Effect.andThen(spaces.refreshName(spaces.personalSpaceId)),
        Effect.andThen(SubscriptionRef.get(spaces.summaries)),
      ),
    );
    yield* ipc.handlePlainCommand("spaces:open-link", (event, url) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const target =
              parsePageDeepLink(url) ?? parseViewDeepLink(url) ?? parseSessionDeepLink(url);
            if (!target?.spaceId)
              return yield* Effect.fail(new Error("A Space-qualified link is required"));
            return yield* links.handle(url);
          }),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("spaces:join", (event, input) =>
      authorize(event).pipe(Effect.andThen(spaces.join(input))),
    );
    yield* ipc.handlePlainCommand("spaces:leave", (event, spaceId) =>
      authorize(event).pipe(
        Effect.andThen(spaces.leave(spaceId)),
        Effect.andThen(desktops.invalidate(spaceId)),
      ),
    );
    yield* ipc.handlePlainCommand("spaces:switch", (event, spaceId) =>
      Effect.gen(function* () {
        yield* authorize(event);
        const entries = yield* SubscriptionRef.get(spaces.summaries);
        if (!entries.some((entry) => entry.spaceId === spaceId))
          return yield* Effect.fail(new Error("Unknown Space"));
        const url = new URL(event.senderFrame?.url ?? "");
        url.searchParams.delete("project");
        url.searchParams.delete("spaceLink");
        url.searchParams.delete("spaceNotification");
        if (spaceId === spaces.personalSpaceId) url.searchParams.delete("spaceId");
        else url.searchParams.set("spaceId", spaceId);
        return url.toString();
      }),
    );
    yield* SubscriptionRef.changes(spaces.summaries).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          yield* Effect.sync(() =>
            safeBroadcastToWindows(windows.all(), "spaces:changed", [entries]),
          );
          for (const spaceId of tracked) {
            if (entries.some((entry) => entry.spaceId === spaceId)) continue;
            tracked.delete(spaceId);
            yield* FiberMap.remove(observers, spaceId);
            yield* desktops.invalidate(spaceId);
          }
          for (const entry of entries) {
            if (entry.kind !== "team" || tracked.has(entry.spaceId)) continue;
            tracked.add(entry.spaceId);
            yield* FiberMap.run(
              observers,
              entry.spaceId,
              Effect.scoped(desktops.contextEffect(entry.spaceId)).pipe(
                Effect.retry({
                  while: (error) => Schema.is(CoreRuntimeError)(error) && error.retryable,
                  schedule: Schedule.min([
                    Schedule.exponential("250 millis"),
                    Schedule.spaced("15 seconds"),
                  ]).pipe(Schedule.jittered),
                }),
                Effect.catch(() => Effect.void),
              ),
            );
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
).pipe(
  Layer.provideMerge(registry),
  Layer.catch((cause) =>
    Layer.effectDiscard(
      Effect.fail(
        coreRuntimeError({
          operation: "spaces.initialize",
          reason: "operation",
          retryable: false,
          cause,
        }),
      ),
    ),
  ),
);
