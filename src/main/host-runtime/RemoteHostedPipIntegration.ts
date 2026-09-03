import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { AvatarOverlayRuntime } from "../avatar/AvatarOverlayRuntime";
import {
  RemoteHostedPipNativePlatform,
  RemoteHostedPipNativePlatformError,
} from "../platform/electron/RemoteHostedPipNativePlatform";
import { BrowserUseRuntime } from "./BrowserUseRuntime";
import { ChromeControlRuntime } from "./ChromeControlRuntime";
import {
  ComputerUseRuntime,
  type ComputerUseManagedServiceIdentity,
  type ComputerUseManagedServiceSnapshot,
} from "./ComputerUseRuntime";
import { RemoteHostedPipRuntime } from "./RemoteHostedPipRuntime";

const isSameManagedService = (
  left: ComputerUseManagedServiceIdentity | null,
  right: ComputerUseManagedServiceIdentity,
): boolean => left?.generation === right.generation && left.pid === right.pid;

const ignoreFailure = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Remote Hosted PiP integration event failed").pipe(
        Effect.annotateLogs({ cause }),
      ),
    ),
    Effect.asVoid,
  );

/** Single semantic fan-in for the sole native callback owner. */
export const live: Layer.Layer<
  never,
  never,
  | AvatarOverlayRuntime
  | BrowserUseRuntime
  | ChromeControlRuntime
  | ComputerUseRuntime
  | RemoteHostedPipNativePlatform
  | RemoteHostedPipRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const avatar = yield* AvatarOverlayRuntime;
    const browserUse = yield* BrowserUseRuntime;
    const chrome = yield* ChromeControlRuntime;
    const computerUse = yield* ComputerUseRuntime;
    const native = yield* RemoteHostedPipNativePlatform;
    const remoteHostedPip = yield* RemoteHostedPipRuntime;
    const connectionGate = yield* Semaphore.make(1);
    let connectedService: ComputerUseManagedServiceIdentity | null = null;

    const connectManagedService = Effect.fn("RemoteHostedPipIntegration.connectManagedService")(
      function* (service: ComputerUseManagedServiceSnapshot) {
        if (service.status !== "running") return;
        yield* connectionGate.withPermits(1)(
          Effect.gen(function* () {
            const current = computerUse.managedServiceSnapshot();
            if (current.status !== "running" || !isSameManagedService(current, service)) return;
            if (isSameManagedService(connectedService, service)) return;
            const connected = yield* native.connectHost(service.pid);
            if (!connected) {
              return yield* new RemoteHostedPipNativePlatformError({
                operation: "connect-computer-use-host",
                cause: new Error("Native PiP rejected Computer Use host"),
              });
            }
            const latest = computerUse.managedServiceSnapshot();
            if (latest.status !== "running" || !isSameManagedService(latest, service)) return;
            connectedService = { generation: service.generation, pid: service.pid };
          }),
        );
      },
    );

    const takeConnectedService = connectionGate.withPermits(1)(
      Effect.sync(() => {
        const service = connectedService;
        connectedService = null;
        return service;
      }),
    );

    const reconnectManagedService = Effect.fn("RemoteHostedPipIntegration.reconnectManagedService")(
      function* (lost: ComputerUseManagedServiceIdentity) {
        const service = yield* computerUse.reconcileManagedService(lost);
        yield* connectManagedService(service);
      },
    );

    yield* computerUse.managedServiceChanges.pipe(
      Stream.runForEach((service) => ignoreFailure(connectManagedService(service))),
      Effect.forkScoped({ startImmediately: true }),
    );

    yield* chrome.changes.pipe(
      Stream.runForEach((change) =>
        Effect.forEach(
          change.disconnectedInstances,
          (instance) =>
            remoteHostedPip.releaseChromeExtensionInstance({
              browserFamily: instance.family,
              extensionInstanceId: instance.extensionInstanceId,
            }),
          { discard: true },
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    yield* native.events.pipe(
      Stream.runForEach((event) => {
        switch (event.type) {
          case "browser-content-clicked":
            return ignoreFailure(
              Effect.gen(function* () {
                const target = yield* remoteHostedPip.resolveBrowserPresentation(
                  event.presentationId,
                );
                if (!target) return;
                if (target.backend === "chrome") {
                  if (
                    !target.browserFamily ||
                    !target.extensionInstanceId ||
                    !chrome.isConnectedInstance(target.browserFamily, target.extensionInstanceId)
                  ) {
                    return;
                  }
                  yield* chrome.focusPresentation({
                    extensionInstanceId: target.extensionInstanceId,
                    sessionId: target.threadId,
                    tabId: target.tabId,
                  });
                  return;
                }
                if (target.backend !== "iab") return;
                const tabId = Number(target.tabId);
                if (!Number.isSafeInteger(tabId) || tabId < 0) return;
                yield* browserUse.focusPresentation({ sessionId: target.threadId, tabId });
              }),
            );
          case "computer-use-cursor-changed":
            return avatar.setComputerUseCursor(event.point);
          case "host-layout-changed":
            return avatar.applyNativeLayoutState({
              currentHostID: event.layoutState?.currentHostID ?? null,
              stackDisplayHeight: event.layoutState?.stackDisplayHeight ?? 0,
            });
          case "max-display-size-changed":
            return ignoreFailure(remoteHostedPip.setMaxDisplaySize(event.size));
          case "pet-wake-requested":
            return avatar.wake;
          case "service-connection-lost":
            return ignoreFailure(
              Effect.gen(function* () {
                const lost = yield* takeConnectedService;
                if (!lost) return;
                yield* reconnectManagedService(lost).pipe(
                  Effect.retry(Schedule.spaced("500 millis").pipe(Schedule.upTo({ times: 9 }))),
                );
              }),
            );
          case "visibility-requested":
            if (event.threadIds.length === 0) return Effect.void;
            return ignoreFailure(
              remoteHostedPip.setTaskVisibilities(
                event.threadIds,
                event.isVisible ? "shown" : "hidden",
              ),
            );
        }
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
