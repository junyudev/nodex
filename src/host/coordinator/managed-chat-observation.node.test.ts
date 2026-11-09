import { describe, expect, test } from "vitest";
import {
  diffManagedChatObservation as diff,
  MANAGED_CHAT_STALL_MS as STALL,
  unavailableManagedChatFacts,
  type ManagedChatFacts,
  type ManagedChatObservation,
} from "./managed-chat-observation";
const facts = (patch: Partial<ManagedChatFacts> = {}): ManagedChatFacts => ({
  state: "working",
  runId: "run",
  runStartedAt: 0,
  terminalStatus: null,
  pendingRequests: [],
  progressFingerprint: "p1",
  ...patch,
});
const observe = (
  current = facts(),
  previous: ManagedChatObservation | null = null,
  now = 0,
  latestReportAt: number | null = null,
  restartStallClock = false,
) => diff({ sessionId: "chat", previous, facts: current, now, latestReportAt, restartStallClock });
const working = observe().observed;
const question = {
  id: "q",
  kind: "question" as const,
  question: "Keep it?",
  questions: [{ question: "Keep it?", options: [{ label: "Yes", description: "Keep" }] }],
};

describe("managed chat observation", () => {
  test.each(["completed", "failed", "interrupted"] as const)(
    "compares persisted observations after restart without replaying a first-ever %s",
    (terminalStatus) => {
      const current = facts({
        state: terminalStatus === "completed" ? "idle" : "failed",
        terminalStatus,
      });
      expect(observe(current, working, 100, null, true).events.map((e) => e.kind)).toEqual([
        terminalStatus === "completed" ? "turn_ended" : "failed",
      ]);
      expect(observe(current).events).toEqual([]);
    },
  );
  test("still-pending attention is captured on first observation and restart, with real request identities", () => {
    const current = facts({
      state: "waiting",
      pendingRequests: [question, { id: "a", kind: "approval" }],
    });
    const first = observe(current);
    expect(first.events.map((e) => e.dedupe_key)).toEqual(["attention:chat:q", "attention:chat:a"]);
    expect(first.events[0]?.payload).toEqual({
      requestId: "q",
      kind: "question",
      question: "Keep it?",
      questions: question.questions,
    });
    expect(observe(current, first.observed).events).toEqual([]);
    expect(observe(current, first.observed, 0, null, true).events).toEqual([]);
    expect(
      observe(
        {
          ...current,
          pendingRequests: [...current.pendingRequests, { id: "q2", kind: "question" }],
        },
        first.observed,
      ).events.map((e) => e.dedupe_key),
    ).toEqual(["attention:chat:q2"]);
  });
  test.each(["completed", "failed", "interrupted"] as const)(
    "records %s once and never fabricates a terminal event from a missing owner",
    (terminalStatus) => {
      const current = facts({
        state: terminalStatus === "completed" ? "idle" : "failed",
        terminalStatus,
      });
      const ended = observe(current, working);
      expect(ended.events.map((e) => e.dedupe_key)).toEqual([
        `${terminalStatus === "completed" ? "turn_ended" : "failed"}:chat:run`,
      ]);
      expect(observe(current, ended.observed).events).toEqual([]);
      const missing = observe(unavailableManagedChatFacts, working, STALL);
      expect(missing.events).toEqual([]);
      expect(missing.observed).toEqual({ ...working, state: "unavailable" });
      expect(observe(current, missing.observed, STALL + 1).events).toEqual(ended.events);
    },
  );
  test.each([null, -1, 0, 1])(
    "only a report at or after Run start suppresses completion (%s)",
    (latestReportAt) => {
      const result = observe(
        facts({ state: "idle", terminalStatus: "completed" }),
        working,
        100,
        latestReportAt,
      );
      expect(result.events).toHaveLength(latestReportAt !== null && latestReportAt >= 0 ? 0 : 1);
    },
  );
  test("a completed turn with a pending question is waiting on the person, not unreported", () => {
    const ended = facts({
      state: "waiting",
      terminalStatus: "completed",
      pendingRequests: [question],
    });
    const first = observe(ended, working);
    expect(first.events.map((e) => e.kind)).toEqual(["attention"]);
    expect(observe(ended, first.observed).events).toEqual([]);
  });
  test("a Run completed entirely between sweeps is captured, without replaying the prior Run", () => {
    const idle = observe(facts({ state: "idle", terminalStatus: "completed" })).observed;
    expect(
      observe(
        facts({ state: "idle", runId: "next", terminalStatus: "completed" }),
        idle,
      ).events.map((e) => e.dedupe_key),
    ).toEqual(["turn_ended:chat:next"]);
    expect(
      observe(facts({ state: "idle", terminalStatus: "completed", runStartedAt: null }), working)
        .events,
    ).toEqual([]);
  });
  test("stalls at 20 minutes once per progress fingerprint", () => {
    expect(observe(facts(), working, STALL - 1).events).toEqual([]);
    const stalled = observe(facts(), working, STALL);
    expect(stalled.events.map((e) => e.dedupe_key)).toEqual(["stalled:chat:run:p1"]);
    expect(observe(facts(), stalled.observed, STALL * 2).events).toEqual([]);
    const progressed = observe(facts({ progressFingerprint: "p2" }), stalled.observed, STALL + 1);
    expect(progressed.events).toEqual([]);
    expect(progressed.observed.progressSince).toBe(STALL + 1);
    expect(
      observe(facts({ progressFingerprint: "p2" }), progressed.observed, 2 * STALL).events,
    ).toEqual([]);
    expect(
      observe(facts({ progressFingerprint: "p2" }), progressed.observed, 2 * STALL + 1).events.map(
        (e) => e.dedupe_key,
      ),
    ).toEqual(["stalled:chat:run:p2"]);
  });
  test.each(["waiting", "idle", "failed", "unavailable"] as const)(
    "never stalls while %s",
    (state) => {
      expect(
        observe(facts({ state }), working, STALL * 2).events.filter((e) => e.kind === "stalled"),
      ).toEqual([]);
    },
  );
  test("captures an already-stalled execution when it first becomes managed", () => {
    const previous = observe(facts(), working, STALL).observed;
    const input = {
      sessionId: "chat",
      previous,
      facts: facts(),
      now: STALL + 1,
      latestReportAt: null,
    };
    const first = diff({ ...input, eventPrevious: null });
    expect(first.observed).toEqual(previous);
    expect(first.events.map((event) => event.kind)).toEqual(["stalled"]);
    expect(diff({ ...input, eventPrevious: first.observed }).events).toEqual([]);
  });
  test("request resolution, Run replacement, restart and recovery give a fresh stall grace", () => {
    const waiting = observe(
      facts({ state: "waiting", pendingRequests: [question] }),
      working,
      STALL,
    ).observed;
    const resumed = observe(facts(), waiting, STALL * 2);
    expect(resumed.observed.progressSince).toBe(STALL * 2);
    expect(resumed.events).toEqual([]);
    expect(
      observe(facts({ pendingRequests: [question] }), working, STALL).events.map((e) => e.kind),
    ).toEqual(["attention"]);
    for (const result of [
      observe(facts({ runId: "next" }), working, STALL),
      observe(facts(), working, STALL, null, true),
      observe(facts(), observe(unavailableManagedChatFacts).observed, STALL),
    ]) {
      expect(result.events).toEqual([]);
      expect(result.observed.progressSince).toBe(STALL);
    }
  });
});

test("returns exactly the resolved requests, including after restart, without guessing on an unavailable owner", () => {
  const waiting = observe(
    facts({ state: "waiting", pendingRequests: [question, { id: "approval", kind: "approval" }] }),
  ).observed;
  expect(observe(facts({ pendingRequests: [question] }), waiting).resolvedRequestIds).toEqual([
    "approval",
  ]);
  expect(
    observe(facts({ state: "idle", terminalStatus: "completed" }), waiting, 100, null, true)
      .resolvedRequestIds,
  ).toEqual(["approval", "q"]);
  expect(observe(unavailableManagedChatFacts, waiting).resolvedRequestIds).toEqual([]);
});
test.each(["completed", "failed", "interrupted"] as const)(
  "a requested stop produces no %s event or stall nudge",
  (terminalStatus) => {
    expect(
      observe(facts({ state: "failed", terminalStatus, interruptRequested: true }), working).events,
    ).toEqual([]);
    expect(observe(facts({ interruptRequested: true }), working, STALL).events).toEqual([]);
  },
);

test("bounds oversized question envelopes without losing the request or the rest of the observation", () => {
  const result = observe(
    facts({
      pendingRequests: [
        {
          ...question,
          questions: [{ question: '"\\工作'.repeat(10000), options: [{ label: "Continue" }] }],
        },
      ],
    }),
  );
  expect(result.events).toHaveLength(1);
  expect(
    new TextEncoder().encode(JSON.stringify(result.events[0]?.payload)).byteLength,
  ).toBeLessThanOrEqual(24000);
  expect(result.events[0]?.payload).toMatchObject({
    requestId: "q",
    kind: "question",
    truncated: true,
  });
  expect(result.observed.pendingRequestIds).toEqual(["q"]);
});
