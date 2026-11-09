import { it } from "@effect/vitest";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { components } from "@nodex/core-protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import type {
  CodexNotificationConversationFacts,
  CodexThreadNotificationEvent,
} from "../../shared/codex-thread-notification";
import {
  agentRuntimeRow,
  agentRuntimeSnapshotFixture,
} from "../../shared/testing/agent-runtime-snapshot";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import {
  CodexApplicationEventHub,
  type CodexApplicationEvent,
} from "../../main/codex-application/CodexApplicationEventHub";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { UserPresence, type Attendance, type PresenceTarget } from "../UserPresence";
import type { PushRecipient } from "./push-delivery";
import { makeMobilePushEvents, type MobilePush } from "./push-events";

type Audience = components["schemas"]["PhonePushAudience"];
type Turn = components["schemas"]["CurrentTurnNotification"];

const turn = (pageId: string, memberId: string, overrides: Partial<Turn> = {}): Turn => ({
  member_id: memberId,
  page_id: pageId,
  episode: `episode:${pageId}`,
  reason: "question",
  title: "Ship the release",
  body: "Which environment should it go to?",
  session_id: `work:${pageId}`,
  conversation_id: `thread:work:${pageId}`,
  ...overrides,
});

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

const asked = (id: string, turnId = `run:${id}`): CodexThreadNotificationEvent => ({
  type: "user-input-requested",
  hostId: "local",
  conversation: chat(id),
  requestId: `agent-runtime:thread:${id}:session`,
  turnId,
  questionCount: 1,
});

const phone = (memberId: string): PushRecipient => ({
  deviceId: `${memberId}-phone`,
  memberId,
  hostId: JSON.stringify(["space", memberId]),
  registration: {
    handle: `${memberId}-handle`,
    key: "key",
    preferences: { needsYou: true, finished: true },
  },
});

const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

/** A phone projection over a fake host, where Core names the Member each event concerns. */
const harness = Effect.fn("harness")(function* (options: {
  readonly attendance: Effect.Effect<Attendance>;
  readonly onPhone?: (memberId: string, target: PresenceTarget) => boolean;
  readonly items?: readonly AgentTurnItem[];
  readonly member?: (audience: Audience) => string | null;
  readonly managed?: readonly string[];
  /** What the Member's desktops report to the Space: how long since they used one, or null. */
  readonly reported?: (memberId: string) => Effect.Effect<number | null>;
  /** Every Member's current Page Turns, as Core lists them for the host. */
  readonly turns?: () => readonly Turn[];
}) {
  const hub = yield* PubSub.unbounded<CodexApplicationEvent>();
  const inbox = yield* PubSub.unbounded<void>();
  const received = yield* Queue.unbounded<MobilePush>();
  const audiences: Audience[] = [];
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
        read: (input: { kind: string; session_ids?: string[]; session_id?: string }) =>
          Effect.sync(() => ({
            value:
              input.kind === "current_turn_notifications"
                ? { kind: "current_turn_notifications", turns: [...(options.turns?.() ?? [])] }
                : input.kind === "read_coordinator"
                  ? { kind: "read_coordinator", session_id: null }
                  : input.kind === "read_managed_session"
                    ? {
                        kind: "read_managed_session",
                        managed: (options.managed ?? []).includes(input.session_id ?? ""),
                      }
                    : {
                        kind: "session_window",
                        sessions: {
                          items:
                            input.session_ids?.[0] === "hidden"
                              ? []
                              : [{ task: { session: { display_title: "Deploy app" } } }],
                        },
                      },
          })),
      },
    } as unknown as CoreModules["Service"]),
    Effect.provideService(DatabaseNotifierRuntime, {
      inboxInvalidations: Stream.fromPubSub(inbox),
    } as unknown as DatabaseNotifierRuntime["Service"]),
  );
  yield* source
    .pushes({
      recipients: (_sessionId, audience) =>
        Effect.sync(() => {
          audiences.push(audience);
          const member = (options.member ?? (() => "alice"))(audience);
          return member ? [phone(member)] : [];
        }),
      presence: options.reported ?? (() => Effect.succeed(null)),
    })
    .pipe(
      Stream.runForEach((push) => Queue.offer(received, push)),
      Effect.forkScoped({ startImmediately: true }),
    );
  yield* settle;
  const publish = (value: CodexThreadNotificationEvent) =>
    PubSub.publish(hub, { kind: "threadNotification", value }).pipe(Effect.andThen(settle));
  const seen = (conversationId: string, memberId?: string) =>
    PubSub.publish(hub, {
      kind: "conversationSeen",
      value: conversationId,
      ...(memberId ? { memberId } : {}),
    }).pipe(Effect.andThen(settle));
  const inboxChanged = PubSub.publish(inbox, undefined).pipe(
    Effect.andThen(TestClock.adjust("120 millis")),
    Effect.andThen(settle),
  );
  return { publish, seen, inboxChanged, received, audiences };
});

const summary = (push: MobilePush) => ({
  kind: push.message.kind,
  sessionId: push.message.sessionId,
  body: push.message.body,
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
      memberId: "alice",
    });
    const told = yield* Queue.takeAll(h.received);
    expect(told.map(summary)).toEqual([
      { kind: "finished", sessionId: "a", body: "Done, with details" },
      { kind: "failed", sessionId: "b", body: "Run failed" },
      { kind: "finished", sessionId: "c", body: "Stopped" },
      { kind: "finished", sessionId: "d", body: "Finished" },
      { kind: "needs_you", sessionId: "e", body: "Which environment?" },
      { kind: "needs_you", sessionId: "f", body: "Run the migration?" },
      { kind: "needs_you", sessionId: "g", body: "You asked to come back to this chat." },
    ]);
    expect(told.every(({ message }) => message.title === "Deploy app")).toBe(true);
  }),
);

it.effect("keeps a secret question off the phone", () =>
  Effect.gen(function* () {
    const h = yield* harness({ attendance: Effect.succeed("away"), items: [question("q", true)] });
    yield* h.publish(asked("a"));
    expect((yield* Queue.take(h.received)).message.body).toBe("Answer on your desktop");
  }),
);

it.effect("tells phones only what the desktop would consider worth telling", () =>
  Effect.gen(function* () {
    const h = yield* harness({ attendance: Effect.succeed("away"), managed: ["g", "h"] });
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
    // A chat Nodex manages speaks through its posts, for its results and its questions alike.
    yield* h.publish(finished("g"));
    yield* h.publish(asked("h"));
    expect(yield* Queue.size(h.received)).toBe(0);
  }),
);

it.effect("tells only the Member Core names, on that Member's own phones", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      attendance: Effect.succeed("away"),
      items: [question("q")],
      // Core's answer: Alice requested the Run and is asked its question; Bob owns the Page it
      // approves; Carol set the reminder; nobody is entitled to the orphan's question.
      member: (audience) =>
        audience.kind === "reminder_owner"
          ? audience.member_id
          : audience.kind === "request" && audience.request === "approval"
            ? "bob"
            : audience.kind === "request" && audience.run_id === "run:orphan"
              ? null
              : "alice",
    });
    yield* h.publish(asked("a"));
    yield* h.publish({
      type: "approval-requested",
      hostId: "local",
      conversation: chat("b"),
      requestId: "agent-runtime:thread:b:session",
      turnId: "run:b",
      prompt: "Deploy?",
    });
    yield* h.publish(finished("c"));
    yield* h.publish({
      type: "session-reminder",
      hostId: "local",
      conversation: chat("d"),
      remindAt: "2026-11-08T09:00:00.000Z",
      memberId: "carol",
    });
    yield* h.publish(asked("e", "run:orphan"));
    const told = yield* Queue.takeAll(h.received);
    expect(
      told.map(({ recipients, message }) => [
        message.sessionId,
        recipients.map(({ memberId }) => memberId),
      ]),
    ).toEqual([
      ["a", ["alice"]],
      ["b", ["bob"]],
      ["c", ["alice"]],
      ["d", ["carol"]],
    ]);
    expect(h.audiences).toEqual([
      { kind: "request", run_id: "run:a", request: "question" },
      { kind: "request", run_id: "run:b", request: "approval" },
      { kind: "run_requester", run_id: "run:c" },
      { kind: "reminder_owner", member_id: "carol" },
      { kind: "request", run_id: "run:orphan", request: "question" },
    ]);
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

it.effect("does not push a chat its Member has open on a phone", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      attendance: Effect.succeed("away"),
      member: (audience) => (audience.kind === "run_requester" ? audience.run_id.slice(4) : null),
      // Bob's phone shows chat "a"; that says nothing about Alice.
      onPhone: (memberId, { sessionId }) => memberId === "bob" && sessionId === "a",
    });
    yield* h.publish(finished("a", { turnId: "run:bob" }));
    yield* h.publish(finished("a", { turnId: "run:alice" }));
    expect(
      (yield* Queue.takeAll(h.received)).map(({ recipients }) => recipients[0]?.memberId),
    ).toEqual(["alice"]);
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
        member: (audience) =>
          audience.kind === "run_requester" && audience.run_id === "run:bob" ? "bob" : "alice",
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
      // A newer occurrence for the same Member in the same chat replaces the one waiting.
      yield* h.publish(finished("replaced"));
      yield* h.publish(asked("replaced"));
      // Another Member's newer occurrence, or their phone seeing the chat, leaves Alice's waiting.
      yield* h.publish(finished("shared"));
      yield* h.publish(finished("shared", { turnId: "run:bob" }));
      yield* h.seen("thread:shared", "bob");
      expect(yield* Queue.size(h.received)).toBe(0);

      yield* Deferred.succeed(leave, undefined);
      yield* settle;
      const told = yield* Queue.takeAll(h.received);
      expect(
        told
          .map(
            ({ recipients, message }) =>
              `${message.kind} ${message.sessionId} ${recipients[0]?.memberId}`,
          )
          .sort(),
      ).toEqual(["finished completed alice", "finished shared alice", "needs_you replaced alice"]);
    }),
);

it.effect(
  "a team Member at one of their desktops gets no phone push; one at none gets it at once",
  () =>
    Effect.gen(function* () {
      const typing = { alice: true };
      const h = yield* harness({
        // A team host has no screen of its own.
        attendance: Effect.succeed("away"),
        member: (audience) => (audience.kind === "run_requester" ? audience.run_id.slice(4) : null),
        // Alice's laptop reports her using it; Carol's reports her gone quiet since time zero;
        // Bob has no desktop vouching for him.
        reported: (memberId) =>
          Effect.map(Clock.currentTimeMillis, (now) =>
            memberId === "alice"
              ? typing.alice
                ? 1_000
                : now
              : memberId === "carol"
                ? now + 60_000
                : null,
          ),
      });
      yield* h.publish(finished("a", { turnId: "run:alice" }));
      yield* h.publish(finished("b", { turnId: "run:bob" }));
      yield* h.publish(finished("c", { turnId: "run:carol" }));
      const told = (yield* Queue.takeAll(h.received)).map(
        ({ recipients }) => recipients[0]?.memberId,
      );
      expect(told).toEqual(["bob"]);
      // Alice keeps using her desktop, so her finish is left to it.
      yield* TestClock.adjust("30 seconds");
      yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
      expect(yield* Queue.size(h.received)).toBe(0);
      // Carol never touched hers again: once five minutes pass without input she hears about it.
      yield* TestClock.adjust("4 minutes");
      yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });
      expect(
        (yield* Queue.takeAll(h.received)).map(({ recipients }) => recipients[0]?.memberId),
      ).toEqual(["carol"]);
    }),
);

it.effect(
  "a Page Turn reaches only the phones of the Member whose move it is, opening its chat or Page",
  () =>
    Effect.gen(function* () {
      let turns: Turn[] = [turn("already", "alice")];
      // Nodex manages the work chats these Turns wait on, so the Turn is the one notification.
      const h = yield* harness({
        attendance: Effect.succeed("away"),
        turns: () => turns,
        managed: ["work:review", "work:asked", "work:already"],
        member: (audience) =>
          audience.kind === "turn_owner" ? (audience.page_id === "review" ? "bob" : "alice") : null,
      });
      // A Turn already current when the host started stays quiet.
      expect(yield* Queue.size(h.received)).toBe(0);
      turns = [
        ...turns,
        turn("asked", "alice"),
        turn("review", "bob", {
          reason: "review",
          body: "",
          session_id: null,
          conversation_id: null,
        }),
      ];
      yield* h.inboxChanged;
      const told = yield* Queue.takeAll(h.received);
      expect(
        told.map(({ recipients, message }) => ({
          to: recipients.map(({ memberId }) => memberId),
          message,
        })),
      ).toEqual([
        {
          to: ["alice"],
          message: {
            kind: "needs_you",
            sessionId: "work:asked",
            pageId: "asked",
            title: "Ship the release",
            body: "Which environment should it go to?",
          },
        },
        {
          to: ["bob"],
          message: {
            kind: "needs_you",
            pageId: "review",
            title: "Ship the release",
            body: "Ready for your review",
          },
        },
      ]);
      expect(h.audiences).toContainEqual({
        kind: "turn_owner",
        page_id: "review",
        episode: "episode:review",
      });
      // The same Turn is told once, however often its Page changes.
      yield* h.inboxChanged;
      expect(yield* Queue.size(h.received)).toBe(0);
    }),
);

it.effect(
  "a Page Turn waits while its Member is at a computer and is withdrawn once it clears",
  () =>
    Effect.gen(function* () {
      const leave = yield* Deferred.make<void>();
      let turns: Turn[] = [];
      const h = yield* harness({
        attendance: Deferred.await(leave).pipe(Effect.as("away" as const)),
        turns: () => turns,
        managed: ["work:cleared", "work:waiting"],
        member: () => "alice",
      });
      turns = [turn("cleared", "alice"), turn("waiting", "alice")];
      yield* h.inboxChanged;
      // Alice is at her computer: nothing is sent.
      expect(yield* Queue.size(h.received)).toBe(0);
      // One Turn is answered on the desktop before she leaves.
      turns = [turn("waiting", "alice")];
      yield* h.inboxChanged;
      yield* Deferred.succeed(leave, undefined);
      yield* settle;
      expect((yield* Queue.takeAll(h.received)).map(({ message }) => message.pageId)).toEqual([
        "waiting",
      ]);
    }),
);

it.effect(
  "a Turn's question from a chat Nodex does not manage is told once, as that chat's own request",
  () =>
    Effect.gen(function* () {
      let turns: Turn[] = [];
      const h = yield* harness({
        attendance: Effect.succeed("away"),
        items: [question("q")],
        turns: () => turns,
        member: () => "alice",
      });
      yield* h.publish(asked("plain", "run:plain"));
      turns = [turn("plain", "alice", { session_id: "plain", conversation_id: "thread:plain" })];
      yield* h.inboxChanged;
      expect((yield* Queue.takeAll(h.received)).map(({ message }) => message.sessionId)).toEqual([
        "plain",
      ]);
    }),
);
