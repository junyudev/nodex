import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivity as Activity,
} from "../../shared/agent-runtime-api";
import type { CodexThreadNotificationEvent } from "../../shared/codex-thread-notification";
import type {
  DesktopNotificationHideSelector,
  DesktopNotificationPayload,
  ThreadNotificationSettings,
} from "../../shared/types";
import { makeCodexThreadNotificationHandler } from "../codex/codex-thread-notification-handler";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";
import { run, type AgentRuntimeNotificationSession } from "./AgentRuntimeSessionNotifications";

const activity = (
  status: Activity["status"],
  overrides: Partial<AgentRuntimeSessionActivity> = {},
): Activity => ({
  sessionId: "session:a",
  threadId: "thread:a",
  status,
  activeRunId: status === "background" ? null : "run:1",
  pendingRequestCount: status === "waiting" ? 1 : 0,
  backgroundTasks: [],
  providerInstanceId: "codex",
  model: "gpt",
  updatedAt: "2026-10-15T10:00:00.000Z",
  ...overrides,
});

const harness = (options: {
  readonly presented?: boolean;
  readonly settings?: Partial<ThreadNotificationSettings>;
  readonly runStatus?: string;
  readonly reply?: string | null;
  readonly outcomeUnavailable?: boolean;
  readonly sideChatSource?: AgentRuntimeNotificationSession["sideChatSource"];
  readonly unreadableSessionId?: string;
}) => {
  const requests: string[] = [];
  const outcomeInputs: unknown[] = [];
  const connection = {
    identity: { runtimeId: "runtime", runtimeGeneration: "1" },
    request: (method: string, input: unknown) =>
      Effect.sync(() => {
        requests.push(method);
        if (method === "thread.authority") return null;
        if (method === "run.outcome") {
          outcomeInputs.push(input);
          return options.outcomeUnavailable
            ? null
            : {
                status: options.runStatus ?? "completed",
                finalAssistantItemId: options.reply === null ? null : "item:reply",
              };
        }
        if (method === "thread.item")
          return {
            type: "assistant_message",
            text: options.reply ?? "Done. The board is updated.",
          };
        throw new Error(`Unexpected ${method}`);
      }),
  } as unknown as AgentRuntimeProcessConnection;
  const unread: string[] = [];
  const events: CodexThreadNotificationEvent[] = [];
  const unreadAtCompletion: string[][] = [];
  const unreadAtQuestion: string[][] = [];
  const shown: DesktopNotificationPayload[] = [];
  const dismissed: DesktopNotificationHideSelector[] = [];
  // The shared native owner decides policy and copy exactly as for Codex conversations.
  const handle = makeCodexThreadNotificationHandler({
    getSettings: () => ({ turnMode: "always", questionsEnabled: true, ...options.settings }),
    isAppForegrounded: () => options.presented ?? false,
    isConversationSeen: () => options.presented ?? false,
    resolveTargetClientId: () => "client",
    showNotification: (notification) => shown.push(notification),
    dismissNotification: (selector) => dismissed.push(selector),
    dispatchAction: () => true,
    focusTargetClient: () => {},
  });
  const deliver = (transitions: readonly Omit<AgentRuntimeActivityTransition, "connection">[]) =>
    run({
      transitions: Stream.fromIterable(
        transitions.map((transition) => ({ ...transition, connection })),
      ),
      isSeen: () => options.presented ?? false,
      readSession: (sessionId) =>
        sessionId === options.unreadableSessionId
          ? Effect.fail(
              new CoreRuntimeError({
                message: "Session binding is unavailable",
                operation: "workspace.read",
                reason: "request",
                retryable: false,
              }),
            )
          : Effect.succeed({
              title: sessionId === "session:source" ? "Source Session" : "Refine the board",
              archived: false,
              unread: false,
              sideChatSource: sessionId === "session:a" ? (options.sideChatSource ?? null) : null,
            }),
      markUnread: (sessionId) => Effect.sync(() => unread.push(sessionId)),
      publish: (event) => {
        if (event.type === "turn-completed") unreadAtCompletion.push([...unread]);
        if (event.type === "user-input-requested") unreadAtQuestion.push([...unread]);
        events.push(event);
        handle(event);
      },
    });
  return {
    deliver,
    requests,
    outcomeInputs,
    unread,
    unreadAtCompletion,
    unreadAtQuestion,
    events,
    shown,
    dismissed,
  };
};
const transition = (
  before: Activity | null,
  after: Activity | null,
  endedRun: AgentRuntimeActivityTransition["endedRun"] = null,
) => ({ sessionId: "session:a", rootThreadId: "thread:a", before, after, endedRun });

it.effect.each(["completed", "failed", "interrupted", "cancelled"] as const)(
  "%s Run shows its persisted reply after native authority is released",
  (status) =>
    Effect.gen(function* () {
      const h = harness({ runStatus: status });
      yield* h.deliver([transition(activity("running"), null, { runId: "run:1", status })]);
      assert.deepEqual(h.unread, ["session:a"]);
      assert.deepEqual(h.unreadAtCompletion, [["session:a"]]);
      assert.strictEqual(h.shown.length, 1);
      assert.include(h.shown[0]!, {
        id: "turn-run:1",
        kind: "turn-complete",
        title: "Refine the board",
        body: "Done. The board is updated.",
        conversationId: "thread:a",
      });
      assert.deepEqual(h.outcomeInputs, [{ threadId: "thread:a", runId: "run:1" }]);
    }),
);

it.effect("an automatic wake Run after delegated results notifies once it finishes", () =>
  Effect.gen(function* () {
    const h = harness({});
    yield* h.deliver([
      transition(activity("running"), activity("background"), {
        runId: "run:1",
        status: "completed",
      }),
      transition(activity("background"), activity("running", { activeRunId: "run:wake" })),
      transition(activity("running", { activeRunId: "run:wake" }), null, {
        runId: "run:wake",
        status: "completed",
      }),
    ]);
    // The parent turn that handed work to children is continued, not finished.
    assert.deepEqual(
      h.shown.map((notification) => notification.id),
      ["turn-run:wake"],
    );
    assert.deepEqual(h.unread, ["session:a", "session:a"]);
    assert.strictEqual(h.requests.filter((method) => method === "thread.item").length, 1);
  }),
);

it.effect("a seen Session stays read and its completion carries the reply for other channels", () =>
  Effect.gen(function* () {
    const h = harness({ presented: true, settings: { turnMode: "unfocused" } });
    yield* h.deliver([
      transition(activity("running"), null, { runId: "run:1", status: "completed" }),
    ]);
    assert.deepEqual(h.unread, []);
    assert.deepEqual(h.shown, []);
    const event = h.events[0];
    assert.isTrue(
      event?.type === "turn-completed" && event.lastAgentMessage === "Done. The board is updated.",
    );
  }),
);

it.effect("a missed terminal status is read once from the Runtime", () =>
  Effect.gen(function* () {
    const h = harness({ runStatus: "failed" });
    yield* h.deliver([transition(activity("running"), null, { runId: "run:1", status: null })]);
    const event = h.events[0];
    assert.isTrue(event?.type === "turn-completed" && event.status === "failed");
    assert.strictEqual(h.shown.length, 1);
    assert.deepEqual(h.requests, ["run.outcome", "thread.item"]);
  }),
);

it.effect("a new question asks for input and its resolution withdraws the notification", () =>
  Effect.gen(function* () {
    const h = harness({});
    yield* h.deliver([
      transition(activity("running"), activity("waiting")),
      transition(activity("waiting"), activity("running")),
    ]);
    assert.deepEqual(h.unread, ["session:a"]);
    assert.deepEqual(h.unreadAtQuestion, [["session:a"]]);
    assert.strictEqual(h.shown.length, 1);
    assert.include(h.shown[0]!, {
      kind: "question",
      title: "Refine the board",
      body: "Answer 1 question to proceed.",
    });
    assert.deepEqual(h.dismissed, [{ occurrenceId: h.shown[0]!.occurrenceId! }]);
    assert.deepEqual(
      h.events.map((event) => event.type),
      ["user-input-requested", "request-resolved"],
    );
  }),
);

it.effect("approval attention uses the requested action and withdraws on resolution", () =>
  Effect.gen(function* () {
    const h = harness({});
    const waiting = activity("waiting", {
      activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
      approvalPrompt: "git push origin main",
    });
    yield* h.deliver([
      transition(activity("running"), waiting),
      transition(waiting, waiting),
      transition(waiting, activity("running")),
    ]);
    assert.deepEqual(
      h.events.map((event) => event.type),
      ["approval-requested", "request-resolved"],
    );
    assert.deepEqual(h.unread, ["session:a"]);
    assert.strictEqual(h.shown.length, 1);
    assert.include(h.shown[0]!, {
      title: "Refine the board needs approval",
      body: "git push origin main",
      navigationPath: "session:session%3Aa/thread:thread%3Aa",
    });
    assert.deepEqual(h.dismissed, [{ occurrenceId: h.shown[0]!.occurrenceId! }]);
    assert.deepEqual(h.requests, []);
  }),
);

it.effect(
  "switching attention replaces questions and approvals even at the same request count",
  () =>
    Effect.gen(function* () {
      const h = harness({});
      const question = activity("waiting", { activeFlags: ["waitingOnUserInput"] });
      const approval = activity("waiting", { activeFlags: ["waitingOnApproval"] });
      yield* h.deliver([
        transition(activity("running"), question),
        transition(question, approval),
        transition(approval, question),
        transition(question, null),
      ]);
      assert.deepEqual(
        h.events.map((event) => event.type),
        [
          "user-input-requested",
          "request-resolved",
          "approval-requested",
          "request-resolved",
          "user-input-requested",
          "request-resolved",
        ],
      );
      assert.deepEqual(
        h.dismissed,
        h.shown.map((notification) => ({ occurrenceId: notification.occurrenceId! })),
      );
    }),
);

it.effect(
  "another approval action refreshes the waiting episode without a completion notification",
  () =>
    Effect.gen(function* () {
      const h = harness({});
      const first = activity("waiting", {
        activeFlags: ["waitingOnApproval"],
        approvalPrompt: "git fetch",
      });
      const next = activity("waiting", {
        activeFlags: ["waitingOnApproval"],
        approvalPrompt: "git push",
      });
      yield* h.deliver([
        transition(activity("running"), first),
        transition(first, next, { runId: "run:1", status: "completed" }),
        transition(next, null),
      ]);
      assert.deepEqual(
        h.events.map((event) => event.type),
        ["approval-requested", "approval-requested", "request-resolved"],
      );
      assert.deepEqual(
        h.shown.map((notification) => notification.body),
        ["git fetch", "git push"],
      );
      assert.strictEqual(h.shown[0]?.occurrenceId, h.shown[1]?.occurrenceId);
      assert.deepEqual(h.dismissed, [{ occurrenceId: h.shown[1]!.occurrenceId! }]);
      assert.deepEqual(h.requests, []);
    }),
);

it.effect("an asynchronous question revealed at turn end replaces completion", () =>
  Effect.gen(function* () {
    const h = harness({});
    yield* h.deliver([
      transition(activity("running"), activity("running")),
      transition(activity("running"), activity("waiting", { activeRunId: null }), {
        runId: "run:1",
        status: "completed",
      }),
      transition(activity("waiting", { activeRunId: null }), null),
    ]);
    assert.deepEqual(
      h.events.map((event) => event.type),
      ["user-input-requested", "request-resolved"],
    );
    assert.deepEqual(
      h.shown.map((notification) => notification.kind),
      ["question"],
    );
    assert.deepEqual(h.unread, ["session:a"]);
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.dismissed, [{ occurrenceId: h.shown[0]!.occurrenceId! }]);
  }),
);

it.effect("a live question that remains pending through turn end does not notify completion", () =>
  Effect.gen(function* () {
    const h = harness({});
    yield* h.deliver([
      transition(activity("running"), activity("waiting")),
      transition(activity("waiting"), activity("waiting", { activeRunId: null }), {
        runId: "run:1",
        status: "completed",
      }),
      transition(activity("waiting", { activeRunId: null }), null),
    ]);
    assert.deepEqual(
      h.shown.map((notification) => notification.kind),
      ["question"],
    );
    assert.deepEqual(
      h.events.map((event) => event.type),
      ["user-input-requested", "request-resolved"],
    );
    assert.deepEqual(h.unread, ["session:a"]);
    assert.deepEqual(h.dismissed, [{ occurrenceId: h.shown[0]!.occurrenceId! }]);
    assert.notInclude(h.requests, "thread.item");
  }),
);

it.effect("delegated approvals notify their root while child questions leave it running", () =>
  Effect.gen(function* () {
    const h = harness({});
    const running = activity("running", { activeRunId: null });
    const waiting = activity("waiting", { activeRunId: null, activeFlags: ["waitingOnApproval"] });
    yield* h.deliver([
      transition(null, running),
      transition(running, running),
      transition(running, waiting),
      transition(waiting, null),
    ]);
    assert.deepEqual(
      h.shown.map((notification) => notification.kind),
      ["question"],
    );
    assert.deepEqual(
      h.events.map((event) => event.type),
      ["approval-requested", "request-resolved"],
    );
    assert.deepEqual(h.unread, ["session:a"]);
  }),
);

it.effect("an idle side chat's completion opens its tab in the source Session", () =>
  Effect.gen(function* () {
    const h = harness({
      sideChatSource: { sessionId: "session:source/a", rootThreadId: "thread:source/b" },
    });
    yield* h.deliver([
      transition(activity("running", { sideChatSourceThreadId: "thread:source/b" }), null, {
        runId: "run:1",
        status: "completed",
      }),
    ]);
    assert.strictEqual(h.shown.length, 1);
    assert.include(h.shown[0]!, {
      conversationId: "thread:a",
      navigationPath: "session:session%3Asource%2Fa/thread:thread%3Asource%2Fb",
      activateTabId: "sidechat-session:session:a",
      title: "Refine the board",
      body: "Done. The board is updated.",
    });
    assert.deepEqual(h.unreadAtCompletion, [["session:a"]]);
    assert.deepEqual(h.outcomeInputs, [{ threadId: "thread:a", runId: "run:1" }]);
    const event = h.events[0];
    assert.isTrue(event?.type === "turn-completed");
    if (event?.type !== "turn-completed") return;
    assert.strictEqual(event.conversation.runtimeSessionId, "session:a");
  }),
);

it.effect.each(["running", "waiting"] as const)(
  "a %s side chat without a resolvable source never opens its own Scene",
  (status) =>
    Effect.gen(function* () {
      const h = harness({
        sideChatSource: { sessionId: "session:source", rootThreadId: null },
      });
      yield* h.deliver([
        transition(activity(status), null, { runId: "run:1", status: "completed" }),
      ]);
      assert.deepEqual(h.shown, []);
      // Ending a wait still withdraws its question, whoever owned the notification.
      assert.deepEqual(
        h.events.map((event) => event.type),
        status === "waiting" ? ["request-resolved"] : [],
      );
      assert.deepEqual(h.unread, ["session:a"]);
      assert.deepEqual(h.requests, []);
    }),
);

it.effect.each(["question", "approval"] as const)(
  "a temporary side chat notifies once through its visible source (%s)",
  (family) =>
    Effect.gen(function* () {
      const h = harness({
        sideChatSource: { sessionId: "session:source", rootThreadId: "thread:source" },
      });
      const waiting = activity("waiting", {
        activeRunId: null,
        activeFlags: [family === "approval" ? "waitingOnApproval" : "waitingOnUserInput"],
      });
      yield* h.deliver([
        transition(activity("running"), waiting, { runId: "run:1", status: "completed" }),
        {
          ...transition(null, waiting),
          sessionId: "session:source",
          rootThreadId: "thread:source",
        },
        transition(waiting, null),
      ]);
      assert.deepEqual(
        h.shown.map((notification) => notification.conversationId),
        ["thread:source"],
      );
      assert.deepEqual(h.unread, ["session:source"]);
      assert.deepEqual(
        h.events.map((event) => [
          event.type,
          "conversation" in event ? event.conversation.conversationId : event.conversationId,
        ]),
        [
          [family === "approval" ? "approval-requested" : "user-input-requested", "thread:source"],
          ["request-resolved", "thread:a"],
        ],
      );
    }),
);

it.effect("a failed Session binding read leaves later notifications deliverable", () =>
  Effect.gen(function* () {
    const h = harness({ unreadableSessionId: "session:a" });
    yield* h.deliver([
      transition(activity("running"), null, { runId: "run:1", status: "completed" }),
      {
        ...transition(activity("running"), null, { runId: "run:source", status: "completed" }),
        sessionId: "session:source",
        rootThreadId: "thread:source",
      },
    ]);
    assert.deepEqual(
      h.shown.map((notification) => notification.conversationId),
      ["thread:source"],
    );
    assert.deepEqual(h.unread, ["session:source"]);
    assert.strictEqual(h.events.length, 1);
  }),
);

it.effect("a new waiting episode can notify again after resolution", () =>
  Effect.gen(function* () {
    const h = harness({});
    yield* h.deliver([
      transition(activity("running"), activity("waiting")),
      transition(activity("waiting"), activity("running")),
      transition(activity("running"), activity("waiting")),
    ]);
    assert.deepEqual(
      h.shown.map((notification) => notification.kind),
      ["question", "question"],
    );
    assert.deepEqual(h.dismissed, [{ occurrenceId: h.shown[0]!.occurrenceId! }]);
  }),
);

it.effect.each([{ reply: null }, { outcomeUnavailable: true }])(
  "a known terminal Run without a readable reply retains completion fallback",
  (options) =>
    Effect.gen(function* () {
      const h = harness(options);
      yield* h.deliver([
        transition(activity("running"), null, { runId: "run:1", status: "completed" }),
      ]);
      assert.strictEqual(h.shown[0]?.body, "Nodex finished a turn.");
      assert.deepEqual(h.requests, ["run.outcome"]);
    }),
);

it.effect.each([{ outcomeUnavailable: true }, { runStatus: "rolled_back" }])(
  "a missing terminal observation does not notify an unknown or rolled-back Run",
  (options) =>
    Effect.gen(function* () {
      const h = harness(options);
      yield* h.deliver([transition(activity("running"), null, { runId: "run:1", status: null })]);
      assert.deepEqual(h.events, []);
      assert.deepEqual(h.unread, []);
      assert.deepEqual(h.requests, ["run.outcome"]);
    }),
);

it.effect("the ended Run's heartbeat decision still suppresses completion", () =>
  Effect.gen(function* () {
    const h = harness({
      reply: "Quiet update.\n<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>",
    });
    yield* h.deliver([
      transition(activity("running"), null, { runId: "run:1", status: "completed" }),
    ]);
    assert.strictEqual(h.events.length, 1);
    assert.deepEqual(h.shown, []);
  }),
);
