import { shell } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MainConfig } from "../../app/MainConfig";
import { CodexVisualizations } from "../../codex-application/CodexVisualizations";
import { McpAppSandboxRuntime } from "../../host-runtime/McpAppSandboxRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { ElectronClipboard } from "../../platform/electron/ElectronClipboard";
import { resolveVisualizationImageCrop } from "../../../shared/visualization-image-capture";
import { requireCredentialFreeHttpsUrl } from "../../../shared/external-navigation-url";
import { isValidMcpAppSandboxId } from "../../../shared/mcp-app/mcp-app-sandbox-contract";

const guestIdentity = {
  sandboxId: Schema.String.check(Schema.makeFilter(isValidMcpAppSandboxId)),
  initId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
};
const gestureInput = Schema.Struct(guestIdentity);
const releaseInput = Schema.Struct({
  sandboxId: guestIdentity.sandboxId,
  initId: Schema.String.check(Schema.isMinLength(1)),
});
const externalInput = Schema.Struct({
  ...guestIdentity,
  href: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)),
});
const positiveDimension = Schema.Number.check(
  Schema.makeFilter((value) => Number.isFinite(value) && value > 0),
);
const nonnegativeDimension = Schema.Number.check(
  Schema.makeFilter((value) => Number.isFinite(value) && value >= 0),
);
const captureInput = Schema.Struct({
  sandboxId: guestIdentity.sandboxId,
  initId: Schema.String.check(Schema.isMinLength(1)),
  captureRect: Schema.Struct({
    x: nonnegativeDimension,
    y: nonnegativeDimension,
    width: positiveDimension,
    height: positiveDimension,
  }),
  viewportSize: Schema.Struct({ width: positiveDimension, height: positiveDimension }),
}).check(
  Schema.makeFilter(
    (input) =>
      input.captureRect.x + input.captureRect.width <= input.viewportSize.width &&
      input.captureRect.y + input.captureRect.height <= input.viewportSize.height,
  ),
);
export class CodexVisualizationIpcError extends Schema.TaggedError<CodexVisualizationIpcError>()(
  "CodexVisualizationIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | CodexVisualizations | McpAppSandboxRuntime | MainConfig | ElectronClipboard
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const visualizations = yield* CodexVisualizations;
    const sandboxes = yield* McpAppSandboxRuntime;
    const clipboard = yield* ElectronClipboard;
    const config = yield* MainConfig;
    const trusted = (event: import("electron").IpcMainInvokeEvent) =>
      Effect.try({
        try: () =>
          requireTrustedAppRendererSender(event, "Conversation visualization", config.rendererUrl),
        catch: (cause) => new CodexVisualizationIpcError({ operation: "authorize", cause }),
      });
    const capture = Effect.fn("CodexVisualizationIpc.capture")(function* (
      event: import("electron").IpcMainInvokeEvent,
      raw: unknown,
    ) {
      yield* trusted(event);
      const input = yield* Schema.decodeUnknownEffect(captureInput)(raw);
      const image = yield* sandboxes.captureImage(event.sender, input.sandboxId, input.initId);
      const rect = resolveVisualizationImageCrop(
        image.getSize(),
        input.captureRect,
        input.viewportSize,
      );
      if (!rect)
        return yield* new CodexVisualizationIpcError({
          operation: "capture-image",
          cause: new Error("The response image is empty"),
        });
      return yield* Effect.try({
        try: () => image.crop(rect),
        catch: (cause) => new CodexVisualizationIpcError({ operation: "crop-image", cause }),
      });
    });
    yield* ipc.handleQuery("codex:visualization:capture-image", (event, raw) =>
      capture(event, raw).pipe(Effect.map((image) => new Uint8Array(image.toPNG()))),
    );
    yield* ipc.handlePlainCommand("codex:visualization:copy-image", (event, raw) =>
      capture(event, raw).pipe(Effect.flatMap((image) => clipboard.writeImage(image))),
    );
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
    yield* ipc.handleControl("codex:visualization:release", (event, raw) =>
      trusted(event).pipe(
        Effect.andThen(Schema.decodeUnknownEffect(releaseInput)(raw)),
        Effect.map((input) => sandboxes.releaseGuest(event.sender, input.sandboxId, input.initId)),
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
