import { describe, expect, test } from "vite-plus/test";
import type { OrchestrationV2AppThread } from "@nodex/runtime-contracts";
import { threadCreatedAnalytics } from "./ExecutionAnalytics.ts";

const thread = (overrides: Partial<OrchestrationV2AppThread>) =>
  ({
    modelSelection: { model: "gpt-6-luna" },
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t" },
    creationSource: "web",
    createdBy: "user",
    ...overrides,
  }) as OrchestrationV2AppThread;

describe("thread analytics", () => {
  test("describes a new conversation without any of its content", () => {
    expect(threadCreatedAnalytics(thread({ title: "secret plan" as never }), "codex")).toEqual({
      driver: "codex",
      model: "gpt-6-luna",
      kind: "root",
      source: "web",
      actor: "user",
    });
  });

  test("distinguishes subagents, forks and side chats from conversations a person started", () => {
    const lineage = { parentThreadId: "p", rootThreadId: "p" } as never;
    expect(
      threadCreatedAnalytics(
        thread({ lineage: { ...(lineage as object), relationshipToParent: "subagent" } as never }),
        "codex",
      )?.kind,
    ).toBe("subagent");
    expect(
      threadCreatedAnalytics(
        thread({ lineage: { ...(lineage as object), relationshipToParent: "fork" } as never }),
        "codex",
      )?.kind,
    ).toBe("fork");
    expect(threadCreatedAnalytics(thread({ sideChat: {} as never }), "codex")?.kind).toBe(
      "side_chat",
    );
  });

  test("imported history is not new activity", () => {
    expect(threadCreatedAnalytics(thread({ historyOrigin: "native_import" }), "codex")).toBeNull();
    expect(threadCreatedAnalytics(thread({ historyOrigin: "native" }), "codex")).not.toBeNull();
  });
});
