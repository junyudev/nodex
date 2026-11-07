import { describe, expect, test } from "vite-plus/test";
import { productEventFromRuntime } from "./runtime-events";

describe("Agent Runtime facts become catalog events", () => {
  test("a started Thread", () => {
    expect(
      productEventFromRuntime("thread.created", {
        driver: "claudeAgent",
        model: "claude-sonnet-5-5",
        kind: "root",
        source: "web",
        actor: "user",
      }),
    ).toEqual({
      name: "thread_started",
      properties: {
        provider: "claude",
        model: "claude-sonnet-5-5",
        source: "web",
        actor: "user",
        host: "local",
      },
    });
  });

  test("subagents, forks and side chats are not new conversations", () => {
    expect(
      productEventFromRuntime("thread.created", {
        driver: "codex",
        model: "gpt-6-luna",
        kind: "subagent",
        source: "provider",
        actor: "agent",
      }),
    ).toEqual({
      name: "thread_branched",
      properties: {
        provider: "codex",
        model: "gpt-6-luna",
        kind: "subagent",
        source: "provider",
        actor: "agent",
        host: "local",
      },
    });
  });

  test("a completed turn keeps counts and hides a private model", () => {
    expect(
      productEventFromRuntime("provider.turn.completed", {
        provider: "codex",
        model: "acme-internal",
        terminalStatus: "completed",
        usageStatus: "complete",
        effort: "high",
        inputTokens: 120,
        outputTokens: 30,
        durationMs: 1_500,
      }),
    ).toEqual({
      name: "turn_completed",
      value: 1_500,
      properties: {
        provider: "codex",
        model: "other",
        status: "completed",
        effort: "high",
        input_tokens: 120,
        output_tokens: 30,
      },
    });
  });

  test("anything outside the catalog disappears", () => {
    expect(productEventFromRuntime("chatgpt.auth.started", { flow: "direct" })).toBeNull();
    expect(
      productEventFromRuntime("thread.created", { driver: "codex", kind: "unknown-kind" }),
    ).toBeNull();
    expect(
      productEventFromRuntime("provider.turn.completed", {
        provider: "codex",
        terminalStatus: "completed",
        inputTokens: "a lot",
      }),
    ).toBeNull();
  });
});
