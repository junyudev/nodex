import { describe, expect, test } from "vite-plus/test";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import {
  replayCodexConversationEvents,
  replayCodexConversationFixture,
  type CodexConversationReplayContext,
  type CodexConversationReplayEvent,
} from "./codex-conversation-replay";
import { sanitizedCommandLifecycleFixture } from "./test-fixtures/sanitized-command-lifecycle";

function describeEvent(
  event: CodexConversationReplayEvent,
  context: CodexConversationReplayContext,
): string {
  if (event.type === "request") {
    return [
      context.sourceIndex,
      "request",
      event.request.method,
      typeof event.request.id,
      event.request.id,
    ].join(":");
  }

  if (event.notification.method === "serverRequest/resolved") {
    return [
      context.sourceIndex,
      "notification",
      event.notification.method,
      typeof event.notification.params.requestId,
      event.notification.params.requestId,
    ].join(":");
  }

  return [context.sourceIndex, "notification", event.notification.method].join(":");
}

function recordEvent(
  state: readonly string[],
  event: CodexConversationReplayEvent,
  context: CodexConversationReplayContext,
): readonly string[] {
  return [...state, describeEvent(event, context)];
}

function buildHydratedCommandThread(): Thread {
  const initialThread = sanitizedCommandLifecycleFixture.initialThread;
  const commandCompletedEvent: CodexConversationReplayEvent | undefined =
    sanitizedCommandLifecycleFixture.events[4];
  if (initialThread === null || commandCompletedEvent?.type !== "notification") {
    throw new Error("Invalid sanitized command replay fixture");
  }

  const { notification } = commandCompletedEvent;
  if (notification.method !== "item/completed") {
    throw new Error("Invalid sanitized command replay fixture");
  }

  const { item } = notification.params;
  if (item.type !== "commandExecution") {
    throw new Error("Invalid sanitized command replay fixture");
  }

  return {
    ...initialThread,
    turns: initialThread.turns.map((turn) => ({
      ...turn,
      items: [
        {
          ...item,
          status: "inProgress",
          exitCode: null,
          durationMs: null,
        },
      ],
    })),
  };
}

describe("codex conversation replay", () => {
  test("replays complete protocol envelopes in their original interleaved order", () => {
    const fixtureBeforeReplay = JSON.stringify(sanitizedCommandLifecycleFixture);
    const firstReplay = replayCodexConversationFixture(
      sanitizedCommandLifecycleFixture,
      [] as readonly string[],
      recordEvent,
    );
    const secondReplay = replayCodexConversationFixture(
      sanitizedCommandLifecycleFixture,
      [] as readonly string[],
      recordEvent,
    );
    const replayedEvents = replayCodexConversationFixture(
      sanitizedCommandLifecycleFixture,
      [] as readonly CodexConversationReplayEvent[],
      (state, event) => [...state, event],
    );

    expect(JSON.stringify(firstReplay)).toBe(
      JSON.stringify([
        "0:notification:item/started",
        "1:notification:item/commandExecution/outputDelta",
        "2:request:item/commandExecution/requestApproval:number:73",
        "3:notification:serverRequest/resolved:number:73",
        "4:notification:item/completed",
      ]),
    );
    expect(JSON.stringify(secondReplay)).toBe(JSON.stringify(firstReplay));
    expect(JSON.stringify(replayedEvents)).toBe(
      JSON.stringify(sanitizedCommandLifecycleFixture.events),
    );
    expect(JSON.stringify(sanitizedCommandLifecycleFixture)).toBe(fixtureBeforeReplay);
  });

  test("consumes a hydrated command-output suffix across multiple buffered deltas", () => {
    const outputEvent: CodexConversationReplayEvent | undefined =
      sanitizedCommandLifecycleFixture.events[1];
    if (
      outputEvent?.type !== "notification" ||
      outputEvent.notification.method !== "item/commandExecution/outputDelta"
    ) {
      throw new Error("Invalid sanitized command replay fixture");
    }

    const events: readonly CodexConversationReplayEvent[] = [
      sanitizedCommandLifecycleFixture.events[0],
      {
        type: "notification",
        notification: {
          ...outputEvent.notification,
          params: {
            ...outputEvent.notification.params,
            delta: "fixture ",
          },
        },
      },
      {
        type: "notification",
        notification: {
          ...outputEvent.notification,
          params: {
            ...outputEvent.notification.params,
            delta: "output\n",
          },
        },
      },
      ...sanitizedCommandLifecycleFixture.events.slice(2),
    ];
    const replayed = replayCodexConversationEvents({
      threadId: sanitizedCommandLifecycleFixture.threadId,
      initialState: [] as readonly string[],
      hydratedThread: buildHydratedCommandThread(),
      events,
      reduce: recordEvent,
    });

    expect(JSON.stringify(replayed)).toBe(
      JSON.stringify([
        "0:notification:item/started",
        "3:request:item/commandExecution/requestApproval:number:73",
        "4:notification:serverRequest/resolved:number:73",
        "5:notification:item/completed",
      ]),
    );
  });

  test("lets a final agent message replace its buffered text deltas", () => {
    const events = [
      {
        type: "notification",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread_fixture",
            turnId: "turn_fixture",
            itemId: "item_fixture_agent",
            delta: "buffered fixture text",
          },
        },
      },
      {
        type: "notification",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread_fixture",
            turnId: "turn_fixture",
            completedAtMs: 2_000,
            item: {
              questions: null,
              type: "agentMessage",
              id: "item_fixture_agent",
              text: "authoritative fixture text",
              phase: "final_answer",
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      },
    ] satisfies readonly CodexConversationReplayEvent[];

    const replayed = replayCodexConversationEvents({
      threadId: "thread_fixture",
      initialState: [] as readonly string[],
      hydratedThread: null,
      events,
      reduce: recordEvent,
    });

    expect(JSON.stringify(replayed)).toBe(JSON.stringify(["1:notification:item/completed"]));
  });

  test("rejects a hydrated snapshot from a different per-thread buffer", () => {
    let errorMessage = "";
    try {
      replayCodexConversationEvents({
        threadId: "another_thread",
        initialState: [] as readonly string[],
        hydratedThread: buildHydratedCommandThread(),
        events: sanitizedCommandLifecycleFixture.events,
        reduce: recordEvent,
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toBe("Hydrated thread does not match the replay buffer");
  });
});
