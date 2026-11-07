import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2RunJson,
  OrchestrationV2RunRecovery,
  OrchestrationV2TurnCapabilities,
  RunId,
  type OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  OrchestrationEffectRequestV2,
  REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS,
} from "./EffectOutbox.ts";
import {
  classifyRunRecovery,
  isRunRecoveryEligible,
  nextRunRecovery,
  recoveryStreakAfterItem,
  type RunRecoveryEligibility,
  type RunRecoveryKind,
  type RunRecoveryStreak,
} from "./RunRecoveryPolicy.ts";

const now = DateTime.makeUnsafe("2026-11-01T00:00:00.000Z");
const failure = (
  overrides: Partial<OrchestrationV2ProviderFailure> = {},
): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  message: "Request failed.",
  code: null,
  retryable: null,
  ...overrides,
});

describe("classifyRunRecovery", () => {
  const cases: ReadonlyArray<
    readonly [string, Partial<OrchestrationV2ProviderFailure>, RunRecoveryKind]
  > = [
    ...[
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
      "observation_lost",
    ].map((code) => [code, { code }, "connection"] as const),
    [
      "disconnected stream",
      { code: "other", message: "Stream ended before response.completed" },
      "connection",
    ],
    [
      "disconnect in diagnostic",
      { code: "other", diagnostic: "TransportError: connection reset by peer" },
      "connection",
    ],
    ["other without evidence", { code: "other" }, "none"],
    ["transport class", { class: "transport_error" }, "connection"],
    ["transport code", { code: "transport_error" }, "connection"],
    ...[
      "serverOverloaded",
      "internalServerError",
      "overloaded",
      "api_error_500",
      "api_error_503",
      "api_error_529",
      "api_error_599",
    ].map((code) => [code, { code }, "overloaded"] as const),
    ...["rateLimitExceeded", "rate_limit", "api_error_429"].map(
      (code) => [code, { code }, "rate_limit"] as const,
    ),
    ...["flexUnavailable", "policyCapacityUnavailable"].map(
      (code) => [code, { code }, "overloaded"] as const,
    ),
    ...["provider_process_exited", "turn_start_unconfirmed", "provider_event_stream_lost"].map(
      (code) => [code, { code }, "process_lost"] as const,
    ),
    ...[
      "usageLimitExceeded",
      "contextWindowExceeded",
      "sessionBudgetExceeded",
      "context_budget_exhausted",
      "unauthorized",
      "badRequest",
      "cyberPolicy",
      "misalignmentPolicyViolation",
      "tooManyDenials",
      "authentication_failed",
      "invalid_request",
      "api_error_400",
      "api_error_401",
      "api_error_403",
      "api_error_404",
      "modelNotFound",
      "sandboxError",
      "error_max_turns",
      "error_max_budget_usd",
      "context_handoff_delivery_uncertain",
      "turn_ownership_conflict",
      "native_session_unrecoverable",
    ].map((code) => [code, { code }, "none"] as const),
    ["unnamed code", { code: "something_new" }, "none"],
    ["unknown class/cause", { class: "unknown" }, "none"],
    [
      "known Nodex code with unknown class",
      { class: "unknown", code: "observation_lost" },
      "connection",
    ],
    ["explicitly non-retryable", { code: "serverOverloaded", retryable: false }, "none"],
    ["retryable alone is insufficient", { retryable: true }, "none"],
    ["usage-limit 429", { class: "usage_limit", code: "api_error_429", retryable: true }, "none"],
    [
      "usage-limit reset",
      { class: "usage_limit", code: "rateLimitExceeded", resetAt: "2026-11-01T01:00:00Z" },
      "none",
    ],
    ["permission class", { class: "permission_error", code: "serverOverloaded" }, "none"],
    ["validation class", { class: "validation_error", httpStatusCode: 503 }, "none"],
    ["HTTP usage limit", { code: "usageLimitExceeded", httpStatusCode: 429 }, "none"],
    ["HTTP auth rejection", { code: "httpConnectionFailed", httpStatusCode: 401 }, "none"],
    ["HTTP transport class rejection", { class: "transport_error", httpStatusCode: 400 }, "none"],
    [
      "HTTP transient 429",
      { code: "responseTooManyFailedAttempts", httpStatusCode: 429 },
      "rate_limit",
    ],
    ["HTTP connection 429", { code: "httpConnectionFailed", httpStatusCode: 429 }, "rate_limit"],
    ["gateway 502", { code: "httpConnectionFailed", httpStatusCode: 502 }, "connection"],
    ["gateway 504", { code: "responseTooManyFailedAttempts", httpStatusCode: 504 }, "connection"],
    ["encoded gateway 502", { code: "api_error_502" }, "connection"],
    ["overloaded behind 502", { code: "serverOverloaded", httpStatusCode: 502 }, "overloaded"],
    [
      "HTTP retries 503",
      { code: "responseTooManyFailedAttempts", httpStatusCode: 503 },
      "overloaded",
    ],
    ["structured status wins", { code: "api_error_529", httpStatusCode: 429 }, "rate_limit"],
  ];
  it.each(cases)("%s", (_, overrides, expected) => {
    assert.equal(classifyRunRecovery(failure(overrides)), expected);
  });
});

describe("nextRunRecovery", () => {
  it.each([
    ["httpConnectionFailed", [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000], null],
    ["serverOverloaded", [10_000, 30_000, 120_000, 300_000, 600_000, 900_000, 1_800_000], 7],
    ["rateLimitExceeded", [60_000, 300_000, 900_000, 1_800_000], 4],
    ["provider_process_exited", [5_000, 30_000, 120_000, 600_000], 4],
  ] as const)("uses the complete %s schedule", (code, delays, maxAttempts) => {
    let streak: RunRecoveryStreak | null = null;
    for (const [index, delayMs] of delays.entries()) {
      const result = nextRunRecovery({
        failure: failure({ code }),
        now,
        streak,
      });
      assert.notEqual(result.kind, "none");
      assert.ok("status" in result && result.status === "scheduled");
      assert.equal(result.attempt, index + 1);
      assert.equal(result.maxAttempts, maxAttempts);
      assert.equal(result.delayMs, delayMs);
      assert.equal(
        DateTime.formatIso(result.nextAttemptAt),
        DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })),
      );
      assert.equal(result.streakStartedAt, now);
      streak = result;
    }
    if (maxAttempts !== null) {
      const result = nextRunRecovery({
        failure: failure({ code }),
        now,
        streak,
      });
      assert.ok("status" in result && result.status === "exhausted");
      assert.equal(result.maxAttempts, maxAttempts);
    }
  });

  it.each([
    [3_599_999, 60_000],
    [3_600_000, 300_000],
    [86_400_000, 300_000],
  ])("switches connection pacing at %i ms of the streak", (elapsedMs, delayMs) => {
    const result = nextRunRecovery({
      failure: failure({ code: "observation_lost" }),
      now: DateTime.add(now, { milliseconds: elapsedMs }),
      streak: { streakStartedAt: now, attempt: 100 },
    });
    assert.ok("status" in result && result.status === "scheduled");
    assert.equal(result.delayMs, delayMs);
    assert.equal(result.attempt, 101);
    assert.equal(result.maxAttempts, null);
  });

  it.each([
    ["2026-11-01T00:02:00.000Z", undefined, 120_000],
    ["2026-11-01T00:59:59.999Z", undefined, 3_599_999],
    ["2026-11-01T01:00:00.000Z", undefined, 3_600_000],
    ["2026-11-02T00:00:00.000Z", undefined, 3_600_000],
    ["2026-10-31T23:59:59.000Z", undefined, 0],
    ["2026-11-01T00:00:00.000Z", undefined, 0],
    [undefined, 120_000, 120_000],
    [undefined, 7_200_000, 3_600_000],
    [undefined, 0, 0],
    ["2026-11-01T00:02:00.000Z", 30_000, 120_000],
    ["invalid", 30_000, 30_000],
    ["invalid", undefined, 60_000],
  ] as const)("honors reset %s and retry-after %s", (resetAt, retryAfterMs, delayMs) => {
    const result = nextRunRecovery({
      failure: failure({ code: "rateLimitExceeded", resetAt, retryAfterMs }),
      now,
      streak: null,
    });
    assert.ok("status" in result && result.status === "scheduled");
    assert.equal(result.delayMs, delayMs);
  });

  it("keeps rate-limit budgets even when a reset is known", () => {
    const result = nextRunRecovery({
      failure: failure({ code: "rateLimitExceeded", retryAfterMs: 1 }),
      now,
      streak: { streakStartedAt: now, attempt: 4 },
    });
    assert.ok("status" in result && result.status === "exhausted");
  });

  it("retains a streak across failure-kind changes, and resets after model progress", () => {
    const streak = { streakStartedAt: now, attempt: 3 };
    const failed = failure({ code: "serverOverloaded" });
    const fourth = nextRunRecovery({
      failure: failed,
      streak,
      now: DateTime.add(now, { minutes: 10 }),
    });
    assert.ok("status" in fourth && fourth.status === "scheduled");
    assert.equal(fourth.attempt, 4);
    assert.equal(fourth.streakStartedAt, now);
    const later = DateTime.add(now, { hours: 1 });
    const restarted = nextRunRecovery({
      failure: failed,
      streak: recoveryStreakAfterItem(streak, { type: "reasoning" }),
      now: later,
    });
    assert.ok("status" in restarted && restarted.status === "scheduled");
    assert.equal(restarted.attempt, 1);
    assert.equal(restarted.streakStartedAt, later);
    assert.deepEqual(
      nextRunRecovery({
        failure: failure({ code: "badRequest" }),
        streak,
        now,
      }),
      { kind: "none" },
    );
  });

  it.each([
    "assistant_message",
    "reasoning",
    "proposed_plan",
    "todo_list",
    "command_execution",
    "file_change",
    "file_search",
    "web_search",
    "dynamic_tool",
    "subagent",
    "user_input_request",
  ] as const)("%s ends the streak", (type) => {
    assert.equal(recoveryStreakAfterItem({ streakStartedAt: now, attempt: 4 }, { type }), null);
  });
  it.each([
    "error",
    "notification",
    "system_notice",
    "user_message",
    "run_interrupt_request",
    "compaction",
    "checkpoint",
  ] satisfies Array<OrchestrationV2TurnItem["type"]>)(
    "%s does not replenish the retry budget",
    (type) => {
      const streak = { streakStartedAt: now, attempt: 4 };
      assert.equal(recoveryStreakAfterItem(streak, { type }), streak);
    },
  );
});

describe("recovery eligibility", () => {
  const eligible: RunRecoveryEligibility = {
    runStatus: "running",
    isRootTurn: true,
    isNativeSubagentTurn: false,
    isMaintenanceCommand: false,
    threadArchived: false,
    threadDeleted: false,
    interruptRequested: false,
    messageDelivery: "accepted",
    hasNewerUserWork: false,
    providerSelectionChanged: false,
  };
  it.each([
    { isRootTurn: false },
    { isNativeSubagentTurn: true },
    { isMaintenanceCommand: true },
    { threadArchived: true },
    { threadDeleted: true },
    { interruptRequested: true },
    { messageDelivery: "unknown" },
    { hasNewerUserWork: true },
    { providerSelectionChanged: true },
    ...[
      "preparing",
      "queued",
      "waiting",
      "completed",
      "interrupted",
      "failed",
      "cancelled",
      "rolled_back",
    ].map((runStatus) => ({ runStatus })),
  ] as ReadonlyArray<Partial<RunRecoveryEligibility>>)("rejects %j", (override) => {
    assert.equal(isRunRecoveryEligible({ ...eligible, ...override }), false);
  });
  it("allows accepted or never-delivered root work, including delegated child Runs", () => {
    assert.equal(isRunRecoveryEligible(eligible), true);
    assert.equal(
      isRunRecoveryEligible({ ...eligible, runStatus: "starting", messageDelivery: "pending" }),
      true,
    );
  });
});

describe("recovery contracts", () => {
  it("round-trips nested recovery timestamps through Run JSON", () => {
    const recovery: OrchestrationV2RunRecovery = {
      kind: "connection",
      failure: failure({ code: "httpConnectionFailed", httpStatusCode: 502, retryAfterMs: 1000 }),
      streakStartedAt: now,
      attempt: 1,
      maxAttempts: null,
      nextAttemptAt: DateTime.add(now, { seconds: 5 }),
    };
    const internal = Schema.Struct({ recovery: OrchestrationV2Run.fields.recovery });
    const wire = Schema.Struct({ recovery: OrchestrationV2RunJson.fields.recovery });
    const encoded = Schema.encodeSync(wire)({ recovery });
    assert.equal(encoded.recovery?.streakStartedAt, "2026-11-01T00:00:00.000Z");
    assert.equal(encoded.recovery?.nextAttemptAt, "2026-11-01T00:00:05.000Z");
    assert.deepEqual(Schema.decodeUnknownSync(wire)(encoded), { recovery });
    assert.deepEqual(Schema.decodeUnknownSync(internal)({ recovery }), { recovery });
    assert.deepEqual(Schema.decodeUnknownSync(wire)({}), {});
    assert.throws(() =>
      Schema.decodeUnknownSync(wire)({ recovery: { ...encoded.recovery, kind: "none" } }),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(wire)({ recovery: { ...encoded.recovery, attempt: 0 } }),
    );
  });

  it("defaults empty continuation support to false without requiring adapters to opt in", () => {
    const decode = Schema.decodeUnknownSync(
      Schema.Struct({
        supportsEmptyContinuation: OrchestrationV2TurnCapabilities.fields.supportsEmptyContinuation,
      }),
    );
    assert.deepEqual(decode({}), { supportsEmptyContinuation: false });
    assert.deepEqual(decode({ supportsEmptyContinuation: true }), {
      supportsEmptyContinuation: true,
    });
  });

  it("persists recover requests with a positive RunAttempt ordinal and replays them after process loss", () => {
    const codec = Schema.fromJsonString(OrchestrationEffectRequestV2);
    const request = {
      type: "run.recover",
      runId: RunId.make("recover-run"),
      attemptOrdinal: 2,
    } as const;
    assert.deepEqual(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(request)), request);
    assert.throws(() =>
      Schema.decodeUnknownSync(OrchestrationEffectRequestV2)({ ...request, attemptOrdinal: 0 }),
    );
    assert.ok(REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS.includes("run.recover"));
  });
});
