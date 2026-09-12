import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { CodexAppServerNotification } from "@nodex/effect-codex-app-server/client";
import type { CodexRuntimeError } from "./CodexRuntimeError";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";

export type CodexEndpointConnection = {
  /** Production endpoints attach provenance; standalone semantic fixtures may omit it. */
  readonly source?: {
    readonly sourceEpoch: string;
    readonly transportKind: "stdio" | "websocket";
  };
} & (
  | { readonly kind: "stopped"; readonly hostId: string }
  | { readonly kind: "connecting"; readonly hostId: string; readonly generation: number }
  | {
      readonly kind: "ready";
      readonly hostId: string;
      readonly generation: number;
      readonly pid?: number;
    }
  | {
      readonly kind: "backing-off";
      readonly hostId: string;
      readonly generation: number;
      readonly attempt: number;
      readonly error: CodexRuntimeError;
    }
  | { readonly kind: "failed"; readonly hostId: string; readonly error: CodexRuntimeError }
  | { readonly kind: "closing"; readonly hostId: string }
);

export type CodexEndpointEvent =
  | {
      readonly kind: "notification";
      readonly hostId: string;
      readonly generation: number;
      readonly value: CodexAppServerNotification;
    }
  | { readonly kind: "connection"; readonly value: CodexEndpointConnection };

export class CodexEventHub extends Context.Service<
  CodexEventHub,
  {
    readonly events: Stream.Stream<CodexEndpointEvent>;
    readonly publish: (event: CodexEndpointEvent) => Effect.Effect<void>;
  }
>()("nodex/main/codex-runtime/CodexEventHub") {}

export const live: Layer.Layer<CodexEventHub> = Layer.effect(
  CodexEventHub,
  Effect.gen(function* () {
    // Reliable protocol occurrences enter CodexApplicationRequestInbox directly. This fan-out is
    // observational, so slow subscribers repair from canonical state after a sliding gap.
    const events = yield* PubSub.sliding<CodexEndpointEvent>(MAIN_OBSERVATION_EVENT_CAPACITY);
    yield* Effect.addFinalizer(() => PubSub.shutdown(events).pipe(Effect.asVoid));
    return CodexEventHub.of({
      events: Stream.fromPubSub(events),
      publish: Effect.fn("CodexEventHub.publish")((event) =>
        PubSub.publish(events, event).pipe(Effect.asVoid),
      ),
    });
  }),
);
