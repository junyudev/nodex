import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import type { CodexRealtimeVoiceTarget } from "../../shared/codex-realtime-voice";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { createUuidV7 } from "../../shared/uuid-v7";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";

export const runtimeThread = Effect.fn("CodexRuntimeNative.thread")(function* (
  threadId: string,
  application: Option.Option<AgentRuntimeApplication["Service"]>,
) {
  return Option.isSome(application) ? yield* application.value.nativeThread(threadId) : null;
});
type VoiceMethod =
  | "thread/realtime/start"
  | "thread/realtime/stop"
  | "thread/realtime/appendText"
  | "thread/realtime/appendSpeech"
  | "thread/inject_items";
export const captureVoice = Effect.fn("CodexRuntimeNative.captureVoice")(function* (
  target: CodexRealtimeVoiceTarget,
  application: Option.Option<AgentRuntimeApplication["Service"]>,
) {
  const found = yield* runtimeThread(target.threadId, application);
  if (!found) return null;
  if (!found.connection.subscribeNotifications)
    return yield* Effect.fail(new Error("Native event observation is unavailable"));
  const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
  const notifications = yield* found.connection.subscribeNotifications.pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const claimId = createUuidV7();
  const capture = yield* found.connection
    .request("native.voice.prepare", { threadId: target.threadId, claimId })
    .pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  let active = true;
  let lastDelivery: number | null = null;
  const source = capture.source;
  const current = Effect.suspend(() =>
    active ? found.connection.request("native.voice.current", source) : Effect.succeed(false),
  );
  const request = <M extends VoiceMethod>(
    method: M,
    params: ClientRequestParamsByMethod[M],
  ): Effect.Effect<ClientRequestResponsesByMethod[M], unknown> => {
    const common = { source, claimId };
    switch (method) {
      case "thread/realtime/start":
        return found.connection.request("native.voice.start", {
          ...common,
          settings: params,
          sdp:
            (params as ClientRequestParamsByMethod["thread/realtime/start"]).transport?.type ===
            "webrtc"
              ? (
                  (params as ClientRequestParamsByMethod["thread/realtime/start"]).transport as {
                    sdp: string;
                  }
                ).sdp
              : "",
        }) as never;
      case "thread/realtime/stop":
        return found.connection.request("native.voice.stop", common) as never;
      case "thread/realtime/appendText":
        return found.connection.request("native.voice.append-text", {
          ...common,
          ...(params as ClientRequestParamsByMethod["thread/realtime/appendText"]),
          role:
            (params as ClientRequestParamsByMethod["thread/realtime/appendText"]).role ?? "user",
        }) as never;
      case "thread/realtime/appendSpeech":
        return found.connection.request("native.voice.append-speech", {
          ...common,
          ...(params as ClientRequestParamsByMethod["thread/realtime/appendSpeech"]),
        }) as never;
      case "thread/inject_items":
        return found.connection.request("native.voice.inject", {
          ...common,
          items: (params as ClientRequestParamsByMethod["thread/inject_items"]).items,
        }) as never;
    }
    return Effect.die("Unsupported voice operation");
  };
  return {
    claimId,
    capture,
    current,
    request,
    active: () => active,
    capabilities: createCodexAppServerCapabilitySnapshot({
      hostId: target.hostId,
      generation: source.nativeGeneration,
      sourceEpoch: JSON.stringify(source),
      userAgent: capture.userAgent,
      nativeAppTools: true,
    }),
    notifications: notifications.pipe(
      Stream.mapEffect((delivery) =>
        Effect.suspend(() => {
          if (lastDelivery !== null && delivery.delivery !== lastDelivery + 1) {
            active = false;
            return Effect.fail(
              codexRuntimeError({
                operation: "voice-observation",
                reason: "pressure",
                retryable: false,
                hostId: target.hostId,
              }),
            );
          }
          lastDelivery = delivery.delivery;
          return Effect.succeed(delivery.notification);
        }),
      ),
      Stream.filter(
        (notification) =>
          (notification.type === "native.voice.event" ||
            notification.type === "native.voice.closed") &&
          notification.claimId === claimId,
      ),
    ),
    release: Effect.suspend(() => {
      active = false;
      return found.connection
        .request("native.voice.release", { claimId })
        .pipe(Effect.ignore, Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  };
});
export type RuntimeVoiceCapture = NonNullable<Effect.Success<ReturnType<typeof captureVoice>>>;
