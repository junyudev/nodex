import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CodexDesktopMessageFromView } from "../../../shared/remote-hosted-pip";
import { MainConfig } from "../../app/MainConfig";
import { RemoteHostedPipRuntime } from "../../host-runtime/RemoteHostedPipRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

export class RemoteHostedPipIpcError extends Schema.TaggedError<RemoteHostedPipIpcError>()(
  "RemoteHostedPipIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const ViewportRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const HostLayout = Schema.Struct({
  anchors: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        alignment: Schema.Literals(["top-left", "top-right", "bottom-left", "bottom-right"]),
        point: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
      }),
    ),
  ),
  anchorRect: Schema.NullOr(ViewportRect),
  animated: Schema.Boolean,
  hostId: Schema.String,
  presentationScope: Schema.Literals(["thread", "all"]),
});
const MessageFromView = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("remote-hosted-pip-active-thread-changed"),
    conversationId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("remote-hosted-pip-hidden-thread-ids-changed"),
    hiddenThreadIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("remote-hosted-pip-host-layout-changed"),
    layout: HostLayout,
  }),
]);
const decodeMessage = Schema.decodeUnknownEffect(MessageFromView);

export const live: Layer.Layer<never, never, ElectronIpc | MainConfig | RemoteHostedPipRuntime> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const ipc = yield* ElectronIpc;
      const config = yield* MainConfig;
      const remoteHostedPip = yield* RemoteHostedPipRuntime;
      yield* ipc.handleControl("codex-desktop:message-from-view", (event, rawMessage: unknown) =>
        Effect.try({
          try: () =>
            requireTrustedAppRendererSender(event, "Remote Hosted PiP", config.rendererUrl),
          catch: (cause) => new RemoteHostedPipIpcError({ operation: "authorize-renderer", cause }),
        }).pipe(
          Effect.andThen(
            decodeMessage(rawMessage).pipe(
              Effect.map((message) => message as unknown as CodexDesktopMessageFromView),
              Effect.mapError(
                (cause) => new RemoteHostedPipIpcError({ operation: "decode-message", cause }),
              ),
            ),
          ),
          Effect.flatMap((message) =>
            remoteHostedPip.handleDesktopMessageFromView(event.sender, message),
          ),
        ),
      );
    }),
  );
