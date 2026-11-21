import {
  EventId,
  MessageId,
  OrchestrationV2StoredEvent,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { projectStoredEventForWire } from "../orchestration-v2/WireProjection.ts";
import type { AgentEvent, AgentRuntimeNotification } from "./Interface.ts";
import {
  applyWireItemPatch,
  LiveWireItems,
  READER_LIVE_ITEM_LIMIT,
  type WireItem,
} from "./ItemPatch.ts";
import { makeTranscriptDelivery } from "./TranscriptDelivery.ts";

const encode = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2StoredEvent));
const THREAD = ThreadId.make("thread:transcript-delivery");
const RUN = RunId.make("run:transcript-delivery");
const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 22, 0, 0, second));

function item(
  type: "assistant_message" | "reasoning",
  index: number,
  text: string,
  streaming: boolean,
  second: number,
): OrchestrationV2TurnItem {
  const base = {
    id: TurnItemId.make(`item:${type}:${index}`),
    threadId: THREAD,
    runId: RUN,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index,
    status: streaming ? ("running" as const) : ("completed" as const),
    title: null,
    startedAt: at(0),
    completedAt: streaming ? null : at(second),
    updatedAt: at(second),
    text,
    streaming,
  };
  return type === "assistant_message"
    ? { ...base, type, messageId: MessageId.make(`message:${index}`) }
    : { ...base, type };
}

let sequence = 0;
function stored(event: OrchestrationV2DomainEvent): AgentEvent {
  sequence += 1;
  return encode(
    projectStoredEventForWire({ sequence, commandId: null, event }),
  ) as unknown as AgentEvent;
}

const turnItem = (value: OrchestrationV2TurnItem, second: number) =>
  stored({
    type: "turn-item.updated",
    id: EventId.make(`event:${sequence + 1}`),
    threadId: THREAD,
    runId: RUN,
    occurredAt: at(second),
    payload: value,
  });

const message = (role: "user" | "assistant", text: string) =>
  stored({
    type: "message.updated",
    id: EventId.make(`event:${sequence + 1}`),
    threadId: THREAD,
    runId: RUN,
    occurredAt: at(59),
    payload: {
      id: MessageId.make(`message:${role}`),
      threadId: THREAD,
      runId: RUN,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: "web",
      createdAt: at(0),
      updatedAt: at(59),
    },
  });

/** A provider stream cut the way paragraph coalescing delivers it: cumulative text per flush. */
function stream(
  type: "assistant_message" | "reasoning",
  index: number,
  totalBytes: number,
  flushes: number,
): { readonly events: AgentEvent[]; readonly finalText: string } {
  const phrase = "Streaming text grows at the end of the item. ";
  const paragraph = phrase.repeat(Math.ceil(totalBytes / phrase.length));
  const finalText = paragraph.slice(0, totalBytes);
  const events: AgentEvent[] = [];
  for (let flush = 1; flush <= flushes; flush++) {
    const length = Math.round((finalText.length * flush) / flushes);
    events.push(turnItem(item(type, index, finalText.slice(0, length), true, flush % 60), flush));
  }
  events.push(turnItem(item(type, index, finalText, false, 59), 59));
  return { events, finalText };
}

const bytes = (notification: AgentRuntimeNotification) =>
  Buffer.byteLength(JSON.stringify(notification), "utf8") + 1;

/** What a transcript reader rebuilds from its notifications, in order. */
function read(notifications: ReadonlyArray<AgentRuntimeNotification>): WireItem[] {
  const live = new LiveWireItems(READER_LIVE_ITEM_LIMIT);
  const versions: WireItem[] = [];
  for (const notification of notifications) {
    let value: WireItem | null = null;
    if (notification.type === "event" && notification.event.event.type === "turn-item.updated")
      value = notification.event.event.payload as unknown as WireItem;
    if (notification.type === "event.item-patch") {
      const previous = live.get(notification.patch.itemId);
      value = previous === undefined ? null : applyWireItemPatch(previous, notification.patch);
      expect(value, "every patch applies to the reader's copy").not.toBeNull();
    }
    if (value === null) continue;
    live.remember(value);
    versions.push(value);
  }
  return versions;
}

describe("transcript delivery", () => {
  it("sends streamed text once and rebuilds every version the full stream carries", () => {
    const reply = stream("assistant_message", 1, 32 * 1024, 81);
    const thought = stream("reasoning", 2, 128 * 1024, 321);
    const events = [
      ...reply.events,
      ...thought.events,
      message("assistant", reply.finalText),
      message("user", "Next question"),
    ];
    const full = events.map((event): AgentRuntimeNotification => ({
      type: "event",
      subscriptionId: "full",
      event,
    }));
    const deliver = makeTranscriptDelivery("transcript");
    const transcript = events.flatMap((event) => deliver(event) ?? []);

    expect(read(transcript)).toEqual(read(full));

    const itemBytes = (notifications: ReadonlyArray<AgentRuntimeNotification>, id: string) =>
      notifications
        .filter((notification) =>
          notification.type === "event.item-patch"
            ? notification.patch.itemId === id
            : notification.type === "event" &&
              notification.event.event.type === "turn-item.updated" &&
              notification.event.event.payload.id === id,
        )
        .reduce((total, notification) => total + bytes(notification), 0);
    for (const [streamed, id] of [
      [reply, "item:assistant_message:1"],
      [thought, "item:reasoning:2"],
    ] as const) {
      const text = Buffer.byteLength(streamed.finalText, "utf8");
      const frames = streamed.events.length;
      const fullBytes = itemBytes(full, id);
      const transcriptBytes = itemBytes(transcript, id);
      // One whole first version, then patches whose fixed part does not grow with the text.
      expect(transcriptBytes).toBeLessThanOrEqual(text + bytes(full[0]!) + frames * 320);
      expect(fullBytes / transcriptBytes).toBeGreaterThan(10);
    }

    const messages = transcript.filter(
      (notification) =>
        notification.type === "event" && notification.event.event.type === "message.updated",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      event: { event: { payload: { role: "user" } } },
    });
  });

  it("sends a settled item whole the next time and keeps other events unchanged", () => {
    const deliver = makeTranscriptDelivery("transcript");
    const settled = turnItem(item("assistant_message", 3, "Done.", false, 1), 1);
    const again = turnItem(item("assistant_message", 3, "Done. Edited.", false, 2), 2);
    expect(deliver(settled)).toMatchObject({ type: "event", event: settled });
    expect(deliver(again)).toMatchObject({ type: "event", event: again });
    const unrelated = message("user", "Thanks");
    expect(deliver(unrelated)).toEqual({
      type: "event",
      subscriptionId: "transcript",
      event: unrelated,
    });
  });
});
