import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { DeliveryAddress, RecipientAdmissionResult } from "../../../shared/recipient-delivery";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { MainConfig } from "../../app/MainConfig";
import { ProjectionDeliveryRuntime } from "../../core-runtime/ProjectionDeliveryRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ProjectionDeliveryIpcError extends Schema.TaggedError<ProjectionDeliveryIpcError>()(
  "ProjectionDeliveryIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

interface SenderSubscriptions {
  readonly sender: WebContents;
  readonly releases: Map<string, Effect.Effect<void>>;
  readonly onDestroyed: () => void;
}

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | ProjectionDeliveryRuntime | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const delivery = yield* ProjectionDeliveryRuntime;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const senders = new Map<number, SenderSubscriptions>();
    const runDelivery = yield* FiberSet.makeRuntime<never, void, never>();

    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          if (
            !isTrustedAppRendererIpcSender({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: windows.has(event.sender.id),
              senderType: event.sender.getType(),
              senderUrl: event.senderFrame?.url ?? "",
              isMainFrame: event.senderFrame === event.sender.mainFrame,
            })
          ) {
            throw new Error("Local commit audience is available only to an active Nodex window");
          }
        },
        catch: (cause) =>
          new ProjectionDeliveryIpcError({ operation: "authorize-renderer", cause }),
      });
    const releaseSender = (
      senderId: number,
      clearRecipientRecovery: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = senders.get(senderId);
        if (!state) return;
        senders.delete(senderId);
        state.sender.removeListener("destroyed", state.onDestroyed);
        const releases = [...state.releases.values()];
        state.releases.clear();
        yield* Effect.forEach(releases, (release) => release, { discard: true });
        if (clearRecipientRecovery) yield* delivery.releaseSender(senderId);
      });
    const ensureSender = (sender: WebContents): SenderSubscriptions => {
      const existing = senders.get(sender.id);
      if (existing) return existing;
      const state: SenderSubscriptions = {
        sender,
        releases: new Map(),
        onDestroyed: () => {
          void runDelivery(releaseSender(sender.id, true));
        },
      };
      senders.set(sender.id, state);
      sender.once("destroyed", state.onDestroyed);
      return state;
    };
    const unsubscribe = (senderId: number, address: DeliveryAddress): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = senders.get(senderId);
        if (!state) return;
        const key = JSON.stringify(address);
        const release = state.releases.get(key);
        state.releases.delete(key);
        if (release) yield* release;
        if (state.releases.size === 0) yield* releaseSender(senderId, false);
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...senders.keys()], (senderId) => releaseSender(senderId, true), {
        discard: true,
      }),
    );
    yield* ipc.handleControl("local-commit-audience:subscribe", (event, address: DeliveryAddress) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            yield* unsubscribe(event.sender.id, address);
            const subscription = yield* delivery
              .subscribe(event.sender, address)
              .pipe(
                Effect.mapError(
                  (cause) => new ProjectionDeliveryIpcError({ operation: "subscribe", cause }),
                ),
              );
            const state = ensureSender(event.sender);
            state.releases.set(JSON.stringify(address), subscription.release);
          }),
        ),
      ),
    );
    yield* ipc.handleControl(
      "local-commit-audience:unsubscribe",
      (event, address: DeliveryAddress) =>
        authorize(event).pipe(Effect.andThen(unsubscribe(event.sender.id, address))),
    );
    yield* ipc.handleControl(
      "recipient-delivery:admit",
      (event, result: RecipientAdmissionResult) =>
        authorize(event).pipe(
          Effect.andThen(delivery.admitRecipientResult(event.sender.id, result)),
        ),
    );
  }),
);
