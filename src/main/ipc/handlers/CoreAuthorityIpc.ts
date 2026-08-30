import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { IpcMainInvokeEvent } from "electron";
import {
  CORE_AUTHORITY_STATUS_CHANNEL,
  GET_CORE_AUTHORITY_STATUS_CHANNEL,
  RELAUNCH_FOR_CORE_AUTHORITY_CHANNEL,
  RETRY_CORE_AUTHORITY_CHANNEL,
  type CoreAuthorityStatus,
} from "../../../shared/core-authority-status";
import { MainConfig } from "../../app/MainConfig";
import { CoreAuthority, type CoreAuthorityState } from "../../core-runtime/CoreAuthority";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { getLogger } from "../../logging/logger";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class CoreAuthorityIpcError extends Schema.TaggedError<CoreAuthorityIpcError>()(
  "CoreAuthorityIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const toRendererStatus = (state: CoreAuthorityState): CoreAuthorityStatus => {
  if (state.kind === "ready") return { kind: "ready" };
  if (state.kind === "recovering") {
    return { attempt: state.attempt, kind: "recovering" };
  }
  if (state.kind === "stopped") {
    return {
      circuitOpen: false,
      kind: "unavailable",
      message: "Nodex Core has stopped.",
    };
  }
  return {
    circuitOpen: false,
    kind: "unavailable",
    message: "Nodex Core could not reconnect.",
  };
};

export const live: Layer.Layer<
  never,
  never,
  CoreAuthority | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const authority = yield* CoreAuthority;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const logger = getLogger({ component: "core-authority-ipc" });
    let current = toRendererStatus(yield* SubscriptionRef.get(authority.state));

    const authorize = (event: IpcMainInvokeEvent, capabilityName: string) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error(`${capabilityName} requires an active Nodex window`);
          }
        },
        catch: (cause) => new CoreAuthorityIpcError({ operation: "authorize-renderer", cause }),
      });

    yield* ipc.handleQuery(GET_CORE_AUTHORITY_STATUS_CHANNEL, (event) =>
      authorize(event, "Core status").pipe(Effect.as(current)),
    );
    yield* ipc.handlePlainCommand(RETRY_CORE_AUTHORITY_CHANNEL, (event) =>
      authorize(event, "Core recovery").pipe(Effect.andThen(authority.retry)),
    );
    yield* ipc.handlePlainCommand(RELAUNCH_FOR_CORE_AUTHORITY_CHANNEL, (event) =>
      authorize(event, "Core relaunch").pipe(Effect.andThen(authority.requestRelaunch)),
    );
    yield* SubscriptionRef.changes(authority.state).pipe(
      Stream.runForEach((state) =>
        Effect.sync(() => {
          const previous = current;
          current = toRendererStatus(state);
          if (current.kind === "recovering") {
            logger.warn("Native Core generation recovery started", { attempt: current.attempt });
          } else if (current.kind === "unavailable") {
            logger.error("Native Core authority is unavailable", {
              circuitOpen: current.circuitOpen,
            });
          } else if (previous.kind !== "ready") {
            logger.info("Native Core authority recovered");
          }
          safeBroadcastToWindows(windows.all(), CORE_AUTHORITY_STATUS_CHANNEL, [current]);
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
