import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AgentsMapReadInputSchema } from "../../../shared/schemas/agents-map";
import { AgentsMap } from "../../agent-runtime/AgentsMap";
import { isTrustedAppRendererIpcSender } from "../../app-renderer-ipc-authorization";
import { MainConfig } from "../../app/MainConfig";
import { safeBroadcastToPersonalWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const map = yield* AgentsMap;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    yield* ipc.handleQuery("agent-runtime:agents-map:read", (event, value) =>
      Effect.try(() => {
        if (
          !isTrustedAppRendererIpcSender({
            developmentOrigin: config.rendererUrl,
            hasOwnerWindow: windows.has(event.sender.id),
            senderType: event.sender.getType(),
            senderUrl: event.senderFrame?.url ?? "",
            isMainFrame: event.senderFrame === event.sender.mainFrame,
          })
        )
          throw new Error("Agents requires an active Nodex window.");
        return AgentsMapReadInputSchema.parse(value);
      }).pipe(Effect.flatMap(map.read)),
    );
    yield* map.changes.pipe(
      Stream.runForEach((revision) =>
        Effect.sync(() =>
          safeBroadcastToPersonalWindows(windows.all(), "agent-runtime:agents-map:changed", [
            revision,
          ]),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
