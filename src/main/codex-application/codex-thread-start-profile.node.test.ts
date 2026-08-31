import { describe, expect, test } from "vitest";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { requireExactThreadStartProfile } from "./codex-thread-start-profile";

const profile: CodexExecutionProfile = {
  modelId: "gpt-5.6-luna",
  reasoningEffort: "max",
  serviceTier: null,
};

const response = (overrides: Record<string, unknown> = {}) =>
  ({
    thread: { id: "thread-a" },
    model: profile.modelId,
    modelProvider: "openai",
    reasoningEffort: profile.reasoningEffort,
    serviceTier: profile.serviceTier,
    ...overrides,
  }) as never;

describe("Thread start execution profiles", () => {
  test("accepts the exact Codex response", () => {
    expect(() => requireExactThreadStartProfile(response(), profile)).not.toThrow();
  });

  test("accepts the app-server Standard sentinel as the domain null tier", () => {
    expect(() =>
      requireExactThreadStartProfile(response({ serviceTier: "default" }), profile),
    ).not.toThrow();
  });

  test("rejects model fallback before first-Turn admission", () => {
    expect(() =>
      requireExactThreadStartProfile(response({ model: "gpt-5.6-sol" }), profile),
    ).toThrow("modelId");
  });

  test("rejects a real service-tier substitution", () => {
    expect(() =>
      requireExactThreadStartProfile(response({ serviceTier: "priority" }), profile),
    ).toThrow("serviceTier");
  });

  test("does not treat the Standard sentinel as a named tier", () => {
    expect(() =>
      requireExactThreadStartProfile(response({ serviceTier: "default" }), {
        ...profile,
        serviceTier: "priority",
      }),
    ).toThrow("serviceTier");
  });

  test("leaves legacy scalar launches unchanged", () => {
    expect(() =>
      requireExactThreadStartProfile(response({ model: "fallback" }), null),
    ).not.toThrow();
  });
});
