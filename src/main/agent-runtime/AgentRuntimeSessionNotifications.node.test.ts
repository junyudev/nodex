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
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeActivityTransition } from "./AgentRuntimeSessionActivity";
import { run } from "./AgentRuntimeSessionNotifications";

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
  readonly turnMayShow?: boolean;
  readonly settings?: Partial<ThreadNotificationSettings>;
  readonly runStatus?: string;
  readonly reply?: string | null;
  readonly outcomeUnavailable?: boolean;
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
    isConversationPresentedInForeground: () => options.presented ?? false,
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
      isPresentedInForeground: () => options.presented ?? false,
      readSession: () =>
        Effect.succeed({ title: "Refine the board", archived: false, unread: false }),
      markUnread: (sessionId) => Effect.sync(() => unread.push(sessionId)),
      turnMayShow: Effect.succeed(options.turnMayShow ?? true),
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

it.effect("presented Sessions stay read and suppressed turns never read the reply", () =>
  Effect.gen(function* () {
    const h = harness({ presented: true, turnMayShow: false, settings: { turnMode: "unfocused" } });
    yield* h.deliver([
      transition(activity("running"), null, { runId: "run:1", status: "completed" }),
    ]);
    assert.deepEqual(h.unread, []);
    assert.strictEqual(h.events.length, 1);
    assert.deepEqual(h.shown, []);
    assert.deepEqual(h.requests, []);
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

it.effect("a temporary side chat notifies once through its visible source", () =>
  Effect.gen(function* () {
    const h = harness({});
    yield* h.deliver([
      transition(
        activity("running"),
        activity("waiting", { activeRunId: null, sideChatSourceThreadId: "thread:source" }),
        { runId: "run:1", status: "completed" },
      ),
      {
        ...transition(null, activity("waiting", { activeRunId: null })),
        sessionId: "session:source",
        rootThreadId: "thread:source",
      },
    ]);
    assert.deepEqual(
      h.shown.map((notification) => notification.conversationId),
      ["thread:source"],
    );
    assert.deepEqual(h.unread, ["session:source"]);
    assert.deepEqual(
      h.events.map((event) => event.type),
      ["user-input-requested"],
    );
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
