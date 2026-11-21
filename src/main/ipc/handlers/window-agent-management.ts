import { WebContentsDestructionSubscriptions } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { MainConfig } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { AgentRuntimeProcessError } from "../../platform/node/AgentRuntimeProcess";

import type { AcpFailure } from "../../../shared/acp-api";
import type { AgentAcpFailure } from "@nodex/agent-runtime/contracts";
import { AgentManagementError } from "../../agent-runtime/AgentManagementFailure";

/** Account and ACP operation ownership follows the trusted renderer lifetime. */
export const makeWindowAgentManagement = Effect.fn("WindowAgentManagement.make")(function* ({
  changes,
  releaseOwner,
  presentFailure,
}: {
  readonly changes: Stream.Stream<void>;
  readonly releaseOwner: (ownerId: string) => Effect.Effect<void>;
  readonly presentFailure: (failure: AgentAcpFailure) => Effect.Effect<AcpFailure>;
}) {
  const rendererDestruction = yield* WebContentsDestructionSubscriptions;
  const config = yield* MainConfig;
  const windows = yield* WindowRuntime;
  const callbacks = yield* ScopedCallbackRuntime;
  yield* changes.pipe(
    Stream.runForEach(() =>
      Effect.sync(() =>
        safeBroadcastToWindows(windows.all(), "agent-settings-changed", [undefined]),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const owners = new Map<
    number,
    {
      readonly id: string;
      readonly sender: IpcMainInvokeEvent["sender"];
      readonly dispose: () => void;
      readonly releaseDestruction: () => void;
    }
  >();
  const owner = (event: IpcMainInvokeEvent) =>
    Effect.try({
      try: () => {
        if (
          event.sender.isDestroyed() ||
          !isTrustedAppRendererIpcSender({
            developmentOrigin: config.rendererUrl,
            hasOwnerWindow: windows.has(event.sender.id),
            senderType: event.sender.getType(),
            senderUrl: event.senderFrame?.url ?? "",
            isMainFrame: event.senderFrame === event.sender.mainFrame,
          })
        )
          throw new Error("Agent management requires an active Nodex window.");
        const existing = owners.get(event.sender.id);
        if (existing) return existing.id;
        const id = randomUUID();
        const dispose = () => {
          const entry = owners.get(event.sender.id);
          if (!entry) return;
          owners.delete(event.sender.id);
          entry.releaseDestruction();
          event.sender.removeListener("render-process-gone", dispose);
          callbacks.fork(releaseOwner(id));
        };
        const entry = { id, sender: event.sender, dispose, releaseDestruction: () => {} };
        owners.set(event.sender.id, entry);
        entry.releaseDestruction = rendererDestruction.subscribe(event.sender, dispose);
        event.sender.once("render-process-gone", dispose);
        return id;
      },
      catch: () =>
        new AgentManagementError({ message: "Agent management requires an active Nodex window." }),
    });
  const handle = <Input, Output>(
    event: IpcMainInvokeEvent,
    schema: z.ZodType<Input>,
    value: unknown,
    execute: (ownerId: string, input: Input) => Effect.Effect<Output, unknown>,
  ) =>
    Effect.gen(function* () {
      const ownerId = yield* owner(event);
      const input = yield* Effect.try({
        try: () => schema.parse(value),
        catch: () => new AgentManagementError({ message: "Invalid Agent management input." }),
      });
      return yield* execute(ownerId, input);
    }).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((cause) =>
        presentFailure(
          cause instanceof AgentRuntimeProcessError && cause.acp
            ? cause.acp
            : cause instanceof AgentManagementError
              ? { reason: cause.reason ?? "invalid_request", message: cause.message }
              : {
                  reason: "invalid_request",
                  message: "The Agent operation could not be completed.",
                },
        ).pipe(Effect.map((error) => ({ ok: false as const, error }))),
      ),
    );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...owners.values()],
      (entry) =>
        Effect.gen(function* () {
          entry.releaseDestruction();
          entry.sender.removeListener("render-process-gone", entry.dispose);
          yield* releaseOwner(entry.id);
        }),
      { discard: true },
    ),
  );
  return handle;
});
