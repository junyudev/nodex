import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type {
  RemoteHostedPipHostLayout,
  RemoteHostedPipTaskVisibilityInput,
} from "../../../shared/remote-hosted-pip";
import { MainConfig } from "../../app/MainConfig";
import { RemoteHostedPipRuntime } from "../../host-runtime/RemoteHostedPipRuntime";
import { safeSendToWindow } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class RemoteHostedPipIpcError extends Schema.TaggedError<RemoteHostedPipIpcError>()(
  "RemoteHostedPipIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const Coordinate = Schema.Finite.pipe(
  Schema.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 })),
);
const Dimension = Schema.Finite.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
);
const PositiveSpringValue = Schema.Finite.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
);
const SpringVelocity = Schema.Finite.pipe(
  Schema.check(Schema.isBetween({ minimum: -10_000, maximum: 10_000 })),
);
const BoundedIdentifier = Schema.String.pipe(Schema.check(Schema.isLengthBetween(1, 1_024)));
const ViewportRect = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Dimension,
  height: Dimension,
});
const Anchors = Schema.Array(
  Schema.Struct({
    alignment: Schema.Literals(["top-left", "top-right", "bottom-left", "bottom-right"]),
    point: Schema.Struct({ x: Coordinate, y: Coordinate }),
  }),
).pipe(Schema.check(Schema.isMaxLength(4)));
const HostLayout = Schema.Struct({
  anchors: Schema.NullOr(Anchors),
  anchorRect: Schema.NullOr(ViewportRect),
  animated: Schema.Boolean,
  animationSpring: Schema.optionalKey(
    Schema.Struct({
      damping: PositiveSpringValue,
      initialVelocity: SpringVelocity,
      mass: PositiveSpringValue,
      stiffness: PositiveSpringValue,
    }),
  ),
  hostId: BoundedIdentifier,
  interactionPassthroughRect: Schema.optionalKey(Schema.NullOr(ViewportRect)),
  isCodexHomeAvailable: Schema.optionalKey(Schema.Boolean),
  presentationScope: Schema.Literals(["thread", "all"]),
});
const VisibilityInput = Schema.Struct({
  taskId: BoundedIdentifier,
  visibility: Schema.Literals(["hidden", "shown"]),
});
const decodeHostLayout = Schema.decodeUnknownEffect(Schema.NullOr(HostLayout));
const decodeVisibility = Schema.decodeUnknownEffect(VisibilityInput);

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | RemoteHostedPipRuntime | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const remoteHostedPip = yield* RemoteHostedPipRuntime;
    const windows = yield* WindowRuntime;

    const authorize = (event: Electron.IpcMainInvokeEvent, operation: string) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Remote Hosted PiP", config.rendererUrl);
          if (!windows.has(event.sender.id)) throw new Error("Sender is not a primary window");
        },
        catch: (cause) => new RemoteHostedPipIpcError({ operation, cause }),
      });

    yield* ipc.handleQuery("remote-hosted-pip:snapshot", (event) =>
      authorize(event, "authorize-snapshot").pipe(Effect.andThen(remoteHostedPip.snapshot)),
    );
    yield* ipc.handleControl("remote-hosted-pip:host-layout:report", (event, rawLayout) =>
      authorize(event, "authorize-layout").pipe(
        Effect.andThen(
          decodeHostLayout(rawLayout).pipe(
            Effect.flatMap((layout) => {
              if (layout?.anchors) {
                const alignments = layout.anchors.map((anchor) => anchor.alignment);
                if (new Set(alignments).size !== alignments.length) {
                  return Effect.fail(
                    new RemoteHostedPipIpcError({
                      operation: "decode-layout",
                      cause: "Host layout anchors must be unique",
                    }),
                  );
                }
              }
              return Effect.succeed(layout as RemoteHostedPipHostLayout | null);
            }),
            Effect.mapError((cause) =>
              cause instanceof RemoteHostedPipIpcError
                ? cause
                : new RemoteHostedPipIpcError({ operation: "decode-layout", cause }),
            ),
          ),
        ),
        Effect.flatMap((layout) => remoteHostedPip.reportHostLayout(event.sender.id, layout)),
      ),
    );
    yield* ipc.handlePlainCommand("remote-hosted-pip:task-visibility:set", (event, rawInput) =>
      authorize(event, "authorize-visibility").pipe(
        Effect.andThen(
          decodeVisibility(rawInput).pipe(
            Effect.map((input) => input as RemoteHostedPipTaskVisibilityInput),
            Effect.mapError(
              (cause) => new RemoteHostedPipIpcError({ operation: "decode-visibility", cause }),
            ),
          ),
        ),
        Effect.flatMap((input) =>
          remoteHostedPip
            .setTaskVisibility(input.taskId, input.visibility)
            .pipe(Effect.andThen(remoteHostedPip.snapshot)),
        ),
      ),
    );

    yield* remoteHostedPip.revisions.pipe(
      Stream.runForEach((revision) =>
        Effect.sync(() => {
          for (const window of windows.all()) {
            safeSendToWindow(window, "remote-hosted-pip:revision", [{ revision }]);
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
