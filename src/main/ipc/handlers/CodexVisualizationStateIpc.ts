import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { MainConfig } from "../../app/MainConfig";
import { CodexVisualizationState } from "../../codex-application/CodexVisualizationState";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class CodexVisualizationStateIpcError extends Schema.TaggedError<CodexVisualizationStateIpcError>()(
  "CodexVisualizationStateIpcError",
  { cause: Schema.Defect() },
) {}

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | CodexVisualizationState | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const state = yield* CodexVisualizationState;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Widget state", config.rendererUrl);
          if (!windows.has(event.sender.id))
            throw new Error("Widget state requires an active window");
        },
        catch: (cause) => new CodexVisualizationStateIpcError({ cause }),
      });
    yield* ipc.handleQuery("codex:visualization:state:read", (event, identity) =>
      authorize(event).pipe(Effect.andThen(state.read(identity))),
    );
    yield* ipc.handleRevisionedCommand("codex:visualization:state:write", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(state.write(input, String(event.sender.id))),
        Effect.map((commit) => {
          return commit.result;
        }),
      ),
    );
  }),
);
