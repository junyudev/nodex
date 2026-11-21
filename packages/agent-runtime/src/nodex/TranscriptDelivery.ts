import { assertPublicWirePayloadBudget } from "../orchestration-v2/WireProjection.ts";
import type { AgentEvent, AgentRuntimeNotification } from "./Interface.ts";
import {
  diffWireItem,
  LiveWireItems,
  RUNTIME_LIVE_ITEM_LIMIT,
  type WireItem,
} from "./ItemPatch.ts";

/**
 * One transcript subscription's delivery. A live item the subscriber already holds arrives as a
 * patch against that copy, so streamed text crosses the boundary once; assistant message records
 * repeat their item's text and are not sent. Returns null for an event the subscriber skips.
 */
export function makeTranscriptDelivery(subscriptionId: string) {
  const live = new LiveWireItems(RUNTIME_LIVE_ITEM_LIMIT);
  return (event: AgentEvent): AgentRuntimeNotification | null => {
    const domain = event.event;
    if (domain.type === "message.updated" && domain.payload.role === "assistant") return null;
    if (domain.type !== "turn-item.updated")
      return { type: "event", subscriptionId, event: assertPublicWirePayloadBudget(event) };
    const item = domain.payload as WireItem;
    const previous = live.get(item.id);
    live.remember(item);
    const patch = previous === undefined ? null : diffWireItem(previous, item);
    return patch === null
      ? { type: "event", subscriptionId, event: assertPublicWirePayloadBudget(event) }
      : {
          type: "event.item-patch",
          subscriptionId,
          sequence: event.sequence,
          patch: assertPublicWirePayloadBudget(patch),
        };
  };
}
