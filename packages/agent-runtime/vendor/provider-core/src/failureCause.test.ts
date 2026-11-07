import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2ProviderFailure } from "@nodex/runtime-contracts";

import { providerFailureCause, type ProviderFailureCause } from "./failureCause.ts";

const failure = (
  overrides: Partial<OrchestrationV2ProviderFailure> = {},
): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  message: "Request failed.",
  code: null,
  retryable: null,
  ...overrides,
});

describe("providerFailureCause", () => {
  const cases: ReadonlyArray<
    readonly [string, Partial<OrchestrationV2ProviderFailure>, ProviderFailureCause]
  > = [
    ["Codex at capacity", { code: "serverOverloaded" }, "overloaded"],
    ["flex tier unavailable", { code: "flexUnavailable" }, "overloaded"],
    ["policy capacity unavailable", { code: "policyCapacityUnavailable" }, "overloaded"],
    ["encoded 529", { code: "api_error_529" }, "overloaded"],
    ["status 500 under an unnamed code", { code: "futureError", httpStatusCode: 500 }, "overloaded"],
    ["rate limit", { code: "rateLimitExceeded" }, "rate_limit"],
    ["status 429 beats a connection wrapper", { code: "responseStreamDisconnected", httpStatusCode: 429 }, "rate_limit"],
    ["proxy gateway while offline", { code: "httpConnectionFailed", httpStatusCode: 502 }, "connection"],
    ["Codex stream disconnect", { code: "responseStreamDisconnected" }, "connection"],
    ["transport class", { class: "transport_error" }, "connection"],
    ["disconnect evidence in other", { code: "other", diagnostic: "stream closed before response.completed" }, "connection"],
    ["Nodex lost observation", { code: "observation_lost" }, "connection"],
    ["Agent process exited", { code: "provider_process_exited" }, "process_lost"],
    ["Agent event stream closed", { code: "provider_event_stream_lost" }, "process_lost"],
    ["usage limit class wins over 429", { class: "usage_limit", code: "api_error_429" }, "usage_limit"],
    ["usage limit code", { code: "usageLimitExceeded", httpStatusCode: 429 }, "usage_limit"],
    ["sign-in", { code: "unauthorized" }, "authentication"],
    ["status 401 behind a connection wrapper", { code: "httpConnectionFailed", httpStatusCode: 401 }, "authentication"],
    ["typed context budget", { code: "context_budget_exhausted" }, "context_budget"],
    ["policy refusal", { code: "cyberPolicy" }, "refused"],
    ["invalid request status", { class: "transport_error", httpStatusCode: 400 }, "refused"],
    ["validation class beats a 503", { class: "validation_error", httpStatusCode: 503 }, "refused"],
    ["permission class beats overload", { class: "permission_error", code: "serverOverloaded" }, "refused"],
    ["Claude turn limit", { code: "error_max_turns" }, "refused"],
    ["unconfirmed history delivery", { code: "context_handoff_delivery_uncertain" }, "refused"],
    ["unreopenable conversation", { code: "native_session_unrecoverable" }, "unrecoverable"],
    ["no evidence", {}, "unknown"],
    ["other without disconnect evidence", { code: "other", message: "Something broke." }, "unknown"],
    ["unnamed code", { code: "future_provider_error" }, "unknown"],
  ];

  it.each(cases)("%s", (_, overrides, expected) => {
    assert.equal(providerFailureCause(failure(overrides)), expected);
  });
});
