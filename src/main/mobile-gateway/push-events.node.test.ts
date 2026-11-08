import { it } from "@effect/vitest";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { PushPayload } from "@nodex/mobile-protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect } from "vitest";
import type {
  CodexNotificationConversationFacts,
  CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import {
  agentRuntimeRow,
  agentRuntimeSnapshotFixture,
} from "../../shared/testing/agent-runtime-snapshot";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import {
  CodexApplicationEventHub,
  type CodexApplicationEvent,
} from "../codex-application/CodexApplicationEventHub";
import { CoreModules } from "../core-runtime/CoreModules";
import { UserPresence, type PresenceTarget } from "../host-runtime/UserPresence";
import { makeMobilePushEvents } from "./push-events";

const question = (id: string, secret = false) =>
  ({
    type: "user_input_request",
    requestId: id,
    questions: [
      { id: "q", question: "Which environment?", isSecret: secret, header: "Env", options: [] },
    ],
  }) as unknown as AgentTurnItem;

const chat = (
  id: string,
  overrides: Partial<CodexNotificationConversationFacts> = {},
): CodexNotificationConversationFacts => ({
  conversationId: `thread:${id}`,
  title: "Deploy app",
  threadSource: null,
  parentThreadId: null,
  source: null,
  sideConversationParentNavigationPath: null,
  runtimeSessionId: id,
  ...overrides,
});

const finished = (
  id: string,
  overrides: Partial<Extract<CodexThreadNotificationEvent, { type: "turn-completed" }>> = {},
): CodexThreadNotificationEvent => ({
  type: "turn-completed",
  hostId: "local",
  conversation: chat(id),
  turnId: `run:${id}`,
  status: "completed",
  lastAgentMessage: "Done, with details",
  heartbeatAssistantMessage: null,
  automationNotificationDecision: null,
  hasPendingContinuation: false,
  ...overrides,
});

const asked = (id: string): CodexThreadNotificationEvent => ({
  type: "user-input-requested",
  hostId: "local",
  conversation: chat(id),
  requestId: `agent-runtime:thread:${id}:session`,
  turnId: `run:${id}`,
  questionCount: 1,
});

const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

/** A phone projection over a fake desktop where the person leaves when `leave` completes. */
const harness = Effect.fn("harness")(function* (options: {
  readonly attendance: Effect.Effect<"returned" | "away">;
  readonly onPhone?: (target: PresenceTarget) => boolean;
  readonly items?: readonly AgentTurnItem[];
}) {
  const hub = yield* PubSub.unbounded<CodexApplicationEvent>();
  const received = yield* Queue.unbounded<PushPayload>();
  const items = options.items ?? [];
  const source = yield* makeMobilePushEvents.pipe(
    Effect.provideService(CodexApplicationEventHub, {
      events: Stream.fromPubSub(hub),
      publish: (event: CodexApplicationEvent) => {
        PubSub.publishUnsafe(hub, event);
      },
    }),
    Effect.provideService(UserPresence, {
      isSeen: () => false,
      isOnPhone: options.onPhone ?? (() => false),
      showOnPhone: () => Effect.void,
      attendanceSince: () => options.attendance,
    }),
    Effect.provideService(AgentRuntimeApplication, {
      read: () =>
        Effect.succeed({
          snapshot: agentRuntimeSnapshotFixture({
            projection: {
              turnItems: [...items],
              runtimeRequests: items.map((item) =>
                agentRuntimeRow("runtimeRequests", {
                  id: "requestId" in item ? item.requestId : "",
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId: "provider-session" },
                }),
              ),
            },
          }),
        }),
    } as unknown as AgentRuntimeApplication["Service"]),
    Effect.provideService(CoreModules, {
      workspace: {
        read: (input: { session_ids: string[] }) =>
          Effect.succeed({
            value: {
              kind: "session_window",
              sessions: {
                items:
                  input.session_ids[0] === "hidden"
                    ? []
                    : [{ task: { session: { display_title: "Deploy app" } } }],
              },
            },
          }),
      },
    } as unknown as CoreModules["Service"]),
  );
  yield* source.events.pipe(
    Stream.runForEach((payload) => Queue.offer(received, payload)),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* settle;
  const publish = (value: CodexThreadNotificationEvent) =>
    PubSub.publish(hub, { kind: "threadNotification", value }).pipe(Effect.andThen(settle));
  const seen = (conversationId: string) =>
    PubSub.publish(hub, { kind: "conversationSeen", value: conversationId }).pipe(
      Effect.andThen(settle),
    );
  return { publish, seen, received };
});

it.effect("tells a phone at once when the person is already away, in the phone's words", () =>
  Effect.gen(function* () {
    const h = yield* harness({ attendance: Effect.succeed("away"), items: [question("q")] });
    yield* h.publish(finished("a"));
    yield* h.publish(finished("b", { status: "failed" }));
    yield* h.publish(finished("c", { status: "interrupted", lastAgentMessage: null }));
    yield* h.publish(finished("d", { lastAgentMessage: null }));
    yield* h.publish(asked("e"));
    yield* h.publish({
      type: "approval-requested",
      hostId: "local",
      conversation: chat("f"),
      requestId: "agent-runtime:thread:f:session",
      turnId: "run:f",
      prompt: "Run the migration?",
    });
    yield* h.publish({
      type: "session-reminder",
      hostId: "local",
      conversation: chat("g"),
      remindAt: "2026-11-08T09:00:00.000Z",
    });
    const told = yield* Queue.takeAll(h.received);
    expect(told.map(({ kind, sessionId, body }) => ({ kind, sessionId, body }))).toEqual([
      { kind: "finished", sessionId: "a", body: "Done, with details" },
      { kind: "failed", sessionId: "b", body: "Run failed" },
      { kind: "finished", sessionId: "c", body: "Stopped" },
      { kind: "finished", sessionId: "d", body: "Finished" },
      { kind: "needs_you", sessionId: "e", body: "Which environment?" },
      { kind: "needs_you", sessionId: "f", body: "Run the migration?" },
      { kind: "needs_you", sessionId: "g", body: "You asked to come back to this chat." },
    ]);
    expect(told.every(({ title }) => title === "Deploy app")).toBe(true);
  }),
);

it.effect("keeps a secret question off the phone", () =>
  Effect.gen(function* () {
    const h = yield* harness({ attendance: Effect.succeed("away"), items: [question("q", true)] });
    yield* h.publish(asked("a"));
    expect((yield* Queue.take(h.received)).body).toBe("Answer on your desktop");
  }),
);

it.effect("tells phones only what the desktop would consider worth telling", () =>
  Effect.gen(function* () {
    const h = yield* harness({ attendance: Effect.succeed("away") });
    yield* h.publish(finished("a", { hasPendingContinuation: true }));
    yield* h.publish(finished("b", { conversation: chat("b", { parentThreadId: "parent" }) }));
    yield* h.publish(
      finished("c", {
        conversation: chat("c", {
          sideConversationParentNavigationPath: "session:source/thread:source",
        }),
      }),
    );
    yield* h.publish(finished("d", { conversation: chat("d", { runtimeSessionId: null }) }));
    yield* h.publish(finished("hidden"));
    yield* h.publish(finished("e", { hostId: "remote" }));
    yield* h.publish(
      finished("f", {
        heartbeatAssistantMessage: {
          decision: "DONT_NOTIFY",
          visibleText: "Quiet",
          notificationMessage: null,
        },
      }),
    );
    expect(yield* Queue.size(h.received)).toBe(0);
  }),
);

it.effect("leaves what happens at the computer to the computer", () =>
  Effect.gen(function* () {
    const h = yield* harness({ attendance: Effect.succeed("returned") });
    yield* h.publish(finished("a"));
    yield* h.publish(asked("b"));
    expect(yield* Queue.size(h.received)).toBe(0);
  }),
);

it.effect("does not push a chat that is open on a phone", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      attendance: Effect.succeed("away"),
      onPhone: ({ sessionId }) => sessionId === "a",
    });
    yield* h.publish(finished("a"));
    yield* h.publish(finished("b"));
    expect((yield* Queue.takeAll(h.received)).map(({ sessionId }) => sessionId)).toEqual(["b"]);
  }),
);

it.effect(
  "tells the phone once the person leaves, unless the wait was answered, seen or replaced",
  () =>
    Effect.gen(function* () {
      const leave = yield* Deferred.make<void>();
      const h = yield* harness({
        attendance: Deferred.await(leave).pipe(Effect.as("away" as const)),
        items: [question("q")],
      });
      // Answered on the desktop before the person left.
      yield* h.publish(asked("answered"));
      yield* h.publish({
        type: "request-resolved",
        hostId: "local",
        conversationId: "thread:answered",
        requestId: "agent-runtime:thread:answered:session",
      });
      // A resolved request does not withdraw a completion.
      yield* h.publish(finished("completed"));
      yield* h.publish({
        type: "request-resolved",
        hostId: "local",
        conversationId: "thread:completed",
        requestId: "agent-runtime:thread:completed:session",
      });
      // Seen in a window or on a phone.
      yield* h.publish(finished("seen"));
      yield* h.seen("thread:seen");
      // A newer occurrence in the same chat replaces the one waiting.
      yield* h.publish(finished("replaced"));
      yield* h.publish(asked("replaced"));
      expect(yield* Queue.size(h.received)).toBe(0);

      yield* Deferred.succeed(leave, undefined);
      yield* settle;
      const told = yield* Queue.takeAll(h.received);
      expect(told.map(({ kind, sessionId }) => `${kind} ${sessionId}`).sort()).toEqual([
        "finished completed",
        "needs_you replaced",
      ]);
    }),
);
