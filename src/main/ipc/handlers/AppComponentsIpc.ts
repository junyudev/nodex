import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { APP_COMPONENT_IDS } from "../../../shared/app-components";
import { AppComponents } from "../../app-components/AppComponents";
import { MainConfig } from "../../app/MainConfig";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

class AppComponentsIpcError extends Schema.TaggedError<AppComponentsIpcError>()(
  "AppComponentsIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const ComponentId = Schema.Literals(APP_COMPONENT_IDS);
const SetComponentEnabled = Schema.Struct({ id: ComponentId, enabled: Schema.Boolean });
const decodeId = Schema.decodeUnknownEffect(ComponentId);
const decodeEnabled = Schema.decodeUnknownEffect(SetComponentEnabled);

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const components = yield* AppComponents;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;
    const trusted = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => requireTrustedAppRendererSender(event, "Components", config.rendererUrl),
        catch: (cause) => new AppComponentsIpcError({ operation: "authorize-renderer", cause }),
      });

    yield* ipc.handleQuery("app-components:read", (event) =>
      trusted(event).pipe(Effect.andThen(components.read)),
    );
    yield* ipc.handlePlainCommand("app-components:set-enabled", (event, input) =>
      trusted(event).pipe(
        Effect.andThen(decodeEnabled(input)),
        Effect.flatMap(components.setEnabled),
      ),
    );
    yield* ipc.handlePlainCommand("app-components:request", (event, id) =>
      trusted(event).pipe(
        Effect.andThen(decodeId(id)),
        Effect.flatMap(components.request),
        Effect.andThen(components.read),
      ),
    );
    yield* ipc.handlePlainCommand("app-components:retry", (event, id) =>
      trusted(event).pipe(Effect.andThen(decodeId(id)), Effect.flatMap(components.retry)),
    );

    yield* components.changes.pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() =>
          safeBroadcastToWindows(windows.all(), "app-components:changed", [snapshot]),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
