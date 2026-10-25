import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { IpcMainInvokeEvent } from "electron";
import { ClaudeUsageLogoutSchema } from "../../../shared/schemas/agent-runtime-api";
import { AgentRuntimeClaudeUsage } from "../../agent-runtime/AgentRuntimeClaudeUsage";
import { MainConfig } from "../../app/MainConfig";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class ClaudeUsageIpcError extends Schema.TaggedError<ClaudeUsageIpcError>()(
  "ClaudeUsageIpcError",
  { operation: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Every window shows Main's one Claude usage snapshot and hears each change to it. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const usage = yield* AgentRuntimeClaudeUsage;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
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
          )
            throw new Error("Claude usage requires an active Nodex window");
        },
        catch: (cause) => new ClaudeUsageIpcError({ operation: "authorize", cause }),
      });
    yield* SubscriptionRef.changes(usage.snapshot).pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "agent-runtime:claude-usage-changed", [snapshot]),
        ),
      ),
      Effect.forkScoped,
    );
    yield* ipc.handleQuery("agent-runtime:claude-usage:read", (event) =>
      authorize(event).pipe(Effect.andThen(SubscriptionRef.get(usage.snapshot))),
    );
    yield* ipc.handleQuery("agent-runtime:claude-usage:refresh", (event) =>
      authorize(event).pipe(Effect.andThen(usage.refresh)),
    );
    yield* ipc.handlePlainCommand("agent-runtime:claude-usage:logout", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.try({
            try: () => ClaudeUsageLogoutSchema.parse(input),
            catch: (cause) => new ClaudeUsageIpcError({ operation: "input", cause }),
          }),
        ),
        Effect.flatMap((parsed) => usage.logout(parsed.instanceIds)),
      ),
    );
  }),
);
