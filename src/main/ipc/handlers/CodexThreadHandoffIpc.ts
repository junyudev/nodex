import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { MainConfig } from "../../app/MainConfig";
import { CodexThreadHandoffRuntime } from "../../codex-application/CodexThreadHandoffRuntime";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class CodexThreadHandoffIpcError extends Schema.TaggedError<CodexThreadHandoffIpcError>()(
  "CodexThreadHandoffIpcError",
  { cause: Schema.Defect() },
) {}

/** One Profile projection; conversation consumers select the originating tool's operation. */
export const live: Layer.Layer<
  never,
  never,
  MainConfig | CodexThreadHandoffRuntime | ElectronIpc | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const handoffs = yield* CodexThreadHandoffRuntime;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    yield* ipc.handleQuery("codex:thread-handoffs:list", (event) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Thread handoff", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Thread handoff access requires an active Nodex window");
          }
        },
        catch: (cause) => new CodexThreadHandoffIpcError({ cause }),
      }).pipe(Effect.andThen(handoffs.snapshot)),
    );
    yield* handoffs.changes.pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "codex:thread-handoffs:changed", [snapshot]),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
