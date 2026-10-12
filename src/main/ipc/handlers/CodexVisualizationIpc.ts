import { shell } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MainConfig } from "../../app/MainConfig";
import { CodexVisualizations } from "../../codex-application/CodexVisualizations";
import { McpAppSandboxRuntime } from "../../host-runtime/McpAppSandboxRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { requireCredentialFreeHttpsUrl } from "../../../shared/external-navigation-url";
import { isValidMcpAppSandboxId } from "../../../shared/mcp-app/mcp-app-sandbox-contract";

const guestIdentity = {
  sandboxId: Schema.String.check(Schema.makeFilter(isValidMcpAppSandboxId)),
  initId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
};
const gestureInput = Schema.Struct(guestIdentity);
const externalInput = Schema.Struct({
  ...guestIdentity,
  href: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
});
export class CodexVisualizationIpcError extends Schema.TaggedError<CodexVisualizationIpcError>()(
  "CodexVisualizationIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | CodexVisualizations | McpAppSandboxRuntime | MainConfig
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const visualizations = yield* CodexVisualizations;
    const sandboxes = yield* McpAppSandboxRuntime;
    const config = yield* MainConfig;
    const trusted = (event: import("electron").IpcMainInvokeEvent) =>
      Effect.try({
        try: () =>
          requireTrustedAppRendererSender(event, "Conversation visualization", config.rendererUrl),
        catch: (cause) => new CodexVisualizationIpcError({ operation: "authorize", cause }),
      });
    yield* ipc.handleQuery("codex:visualization:read", (event, input) =>
      trusted(event).pipe(Effect.andThen(visualizations.read(input))),
    );
    yield* ipc.handleControl("codex:visualization:consume-gesture", (event, raw) =>
      trusted(event).pipe(
        Effect.andThen(Schema.decodeUnknownEffect(gestureInput)(raw)),
        Effect.map((input) =>
          sandboxes.consumeUserGesture(event.sender, input.sandboxId, input.initId),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("codex:visualization:open-external", (event, raw) =>
      trusted(event).pipe(
        Effect.andThen(Schema.decodeUnknownEffect(externalInput)(raw)),
        Effect.flatMap((input) =>
          Effect.gen(function* () {
            const href = yield* Effect.try({
              try: () => requireCredentialFreeHttpsUrl(input.href),
              catch: (cause) =>
                new CodexVisualizationIpcError({ operation: "external-url", cause }),
            });
            if (!sandboxes.consumeUserGesture(event.sender, input.sandboxId, input.initId))
              return false;
            yield* Effect.tryPromise({
              try: () => shell.openExternal(href),
              catch: (cause) =>
                new CodexVisualizationIpcError({ operation: "open-external", cause }),
            });
            return true;
          }),
        ),
      ),
    );
  }),
);
