import { OrchestrationV2StoredEvent } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  assertPublicWirePayloadBudget,
  projectStoredEventForWire,
} from "../orchestration-v2/WireProjection.ts";
import type {
  AgentEvent,
  AgentRuntimeNotification,
  AgentSubagentOverviewItem,
} from "./Interface.ts";
import { makeTranscriptDelivery } from "./TranscriptDelivery.ts";

const encodeEvent = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2StoredEvent));

/**
 * What one observer is sent for each stored event, in order: the event's public wire projection,
 * encoded and held to the transport budget, delivered whole or, on a transcript subscription, as
 * a patch of a live item the subscriber already holds. A subagent tree observer's task update
 * also carries the subagent's overview row. Null for an event the subscriber skips. The host receives
 * each notification as one JSON line.
 */
export function makeObservedEventDelivery(
  subscriptionId: string,
  delivery: "transcript" | "events",
): (
  stored: OrchestrationV2StoredEvent,
  overviewSubagent?: AgentSubagentOverviewItem,
) => Effect.Effect<AgentRuntimeNotification | null, unknown> {
  const deliver =
    delivery === "transcript"
      ? makeTranscriptDelivery(subscriptionId)
      : (event: AgentEvent): AgentRuntimeNotification => ({
          type: "event",
          subscriptionId,
          event: assertPublicWirePayloadBudget(event),
        });
  return (stored, overviewSubagent) =>
    Effect.try(() => projectStoredEventForWire(stored)).pipe(
      Effect.flatMap(encodeEvent),
      Effect.flatMap((encoded) =>
        Effect.try(() =>
          deliver(
            overviewSubagent === undefined
              ? (encoded as AgentEvent)
              : { ...(encoded as AgentEvent), overviewSubagent },
          ),
        ),
      ),
    );
}
