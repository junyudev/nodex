import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MainConfig } from "../../app/MainConfig";
import { McpAppSandboxRuntime } from "../../host-runtime/McpAppSandboxRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { pluginError, pluginFailure } from "../../codex-application/PluginManagementError";

const ContextInput = Schema.Struct({
  hostId: Schema.NonEmptyString,
  projectId: Schema.NullOr(Schema.NonEmptyString),
});
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const sandboxes = yield* McpAppSandboxRuntime;
    const config = yield* MainConfig;
    const input = (event: import("electron").IpcMainInvokeEvent, raw: unknown) =>
      Effect.try({
        try: () => requireTrustedAppRendererSender(event, "MCP app data", config.rendererUrl),
        catch: () => pluginError("policy_denied", "MCP app data requires a trusted Nodex window."),
      }).pipe(
        Effect.andThen(
          Schema.decodeUnknownEffect(ContextInput)(raw).pipe(
            Effect.mapError(() => pluginError("invalid_input", "Invalid MCP app data request.")),
          ),
        ),
      );
    yield* ipc.handleQuery("mcp-app:data:capabilities", (event, raw) =>
      input(event, raw).pipe(
        Effect.map((context) => ({
          available: context.hostId === "local" && sandboxes.appDataAvailable(),
        })),
      ),
    );
    yield* ipc.handlePlainCommand("mcp-app:data:clear", (event, raw) =>
      input(event, raw).pipe(
        Effect.flatMap((context) =>
          context.hostId === "local"
            ? sandboxes.clearAppData.pipe(
                Effect.mapError((error) =>
                  pluginError(
                    error.reason === "unavailable" ? "unsupported" : "service_unavailable",
                    error.reason === "unavailable"
                      ? "MCP app data is unavailable."
                      : "Some MCP app data could not be cleared. Try again.",
                    error.reason === "failed",
                  ),
                ),
              )
            : Effect.fail(
                pluginError("unsupported", "MCP app data is available only on this desktop."),
              ),
        ),
        Effect.as({ status: "success" as const, value: undefined, refreshFailures: [] }),
        Effect.catch((error) =>
          Effect.succeed({
            status:
              error.code === "policy_denied" ? ("policy_denied" as const) : ("failed" as const),
            error: pluginFailure(error),
          }),
        ),
      ),
    );
  }),
);
