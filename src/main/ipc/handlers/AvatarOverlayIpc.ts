import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { AvatarOverlayRendererEvent } from "../../../shared/avatar-overlay";
import { AvatarOverlayRuntime } from "../../avatar/AvatarOverlayRuntime";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

class AvatarOverlayIpcError extends Schema.TaggedError<AvatarOverlayIpcError>()(
  "AvatarOverlayIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const Coordinate = Schema.Finite.pipe(
  Schema.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 })),
);
const Dimension = Schema.Finite.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 16_384 })),
);
const Size = Schema.Struct({ width: Dimension, height: Dimension });
const PointRect = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Dimension,
  height: Dimension,
});
const RendererEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["ready", "close", "hide"]) }),
  Schema.Struct({
    type: Schema.Literal("element-size-changed"),
    mascot: Size,
    tray: Schema.NullOr(Size),
  }),
  Schema.Struct({
    type: Schema.Literal("pointer-regions-changed"),
    regions: Schema.Array(PointRect).pipe(Schema.check(Schema.isMaxLength(64))),
  }),
  Schema.Struct({
    type: Schema.Literal("pointer-interaction-changed"),
    isInteractive: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("drag-start"),
    pointerScreenX: Coordinate,
    pointerScreenY: Coordinate,
    pointerWindowX: Coordinate,
    pointerWindowY: Coordinate,
  }),
  Schema.Struct({
    type: Schema.Literals(["drag-move", "drag-end"]),
    pointerScreenX: Coordinate,
    pointerScreenY: Coordinate,
  }),
]);
const decodeEvent = Schema.decodeUnknownEffect(RendererEvent);

export const live: Layer.Layer<
  never,
  never,
  AvatarOverlayRuntime | ElectronIpc | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const avatar = yield* AvatarOverlayRuntime;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const windows = yield* WindowRuntime;

    const authorizeAvatarEvent = (event: Electron.IpcMainInvokeEvent): void => {
      requireTrustedAppRendererSender(event, "Avatar overlay", config.rendererUrl);
      if (!avatar.ownsWebContents(event.sender.id)) {
        throw new Error("Sender is not the owned Avatar overlay");
      }
      const senderUrl = new URL(event.senderFrame?.url ?? "");
      if (senderUrl.searchParams.get("initialRoute") !== "/avatar-overlay") {
        throw new Error("Sender is not the Avatar overlay route");
      }
    };

    yield* ipc.handleControl("avatar-overlay:event", (event, rawEvent) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => authorizeAvatarEvent(event),
          catch: (cause) => new AvatarOverlayIpcError({ operation: "authorize-event", cause }),
        });
        const decoded = yield* decodeEvent(rawEvent).pipe(
          Effect.mapError(
            (cause) => new AvatarOverlayIpcError({ operation: "decode-event", cause }),
          ),
        );
        return yield* avatar.handleRendererEvent(
          event.sender.id,
          decoded as AvatarOverlayRendererEvent,
        );
      }),
    );

    yield* ipc.handlePlainCommand("avatar-overlay:toggle", (event) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Avatar overlay", config.rendererUrl);
          if (!windows.has(event.sender.id)) throw new Error("Sender is not a primary window");
        },
        catch: (cause) => new AvatarOverlayIpcError({ operation: "authorize-toggle", cause }),
      }).pipe(Effect.andThen(avatar.toggle), Effect.as(true)),
    );
  }),
);
