import { describe, expect, test } from "vite-plus/test";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import {
  projectCodexChildReplyText,
  selectCodexChildThreadReply,
} from "./codex-child-thread-summary";
import {
  codexSpeedTiers,
  fitCodexServiceTier,
  fitCodexServiceTierSelection,
  normalizeCodexServiceTier,
  offeredCodexServiceTier,
} from "./codex-service-tier";
import {
  CodexSidebarThreadMoveInputSchema,
  codexSidebarProjectThreadContainerId,
  isCodexSidebarThreadContainerId,
  readCodexSidebarProjectContainerId,
  readCodexSidebarThreadContainerLocation,
} from "./codex-sidebar-thread-move";
import { resolveCodexSubagentDisplayName } from "./codex-subagent-display";
import type { CodexConversationChildMembership, CodexThreadSummary } from "./types";
import type { CodexMultiAgentReceiverThread } from "./codex-transcript-special-items";
import {
  extractCodexThreadSpawnMetadata,
  extractCodexThreadSubagentMetadata,
  getCodexSubagentOtherSource,
  hasCodexSubagentSource,
} from "./codex-subagent-metadata";
import {
  isCodexSubagentUnresolvedStatus,
  projectCodexSubagentThreadStatus,
  selectCodexSubagentStatusEvidence,
  type CodexSubagentStatusEvidence,
} from "./codex-subagent-overview";

describe("codex child thread summary", () => {
  const reply = (
    text: string,
    phase: "commentary" | "final_answer" | null = null,
    delivery: "async" | null = null,
  ): ThreadItemEntry => ({
    turnId: "turn",
    startedAtMs: null,
    completedAtMs: null,
    item: {
      type: "agentMessage",
      moderation: null,
      id: text,
      text,
      phase,
      delivery,
      memoryCitation: null,
      questions: null,
    },
  });

  describe("created conversation reply summaries", () => {
    test("uses descending item order, skipping synchronous commentary and empty visible replies", () => {
      expect(
        selectCodexChildThreadReply([
          reply("Newest commentary", "commentary"),
          reply("<script>hidden()</script>"),
          reply("**hel**lo [a](https://x)bc"),
        ]),
      ).toBe("hello abc");
    });
    test("includes async commentary without imposing a completion timestamp absent from the producer", () => {
      expect(
        selectCodexChildThreadReply([
          reply("Async **reply**", "commentary", "async"),
          reply("Older answer"),
        ]),
      ).toBe("Async reply");
    });
    test("preserves code content while excluding executable HTML from compact text", () => {
      expect(
        projectCodexChildReplyText("before <style>.secret{}</style> after\n\n```ts\na\n\n\nb\n```"),
      ).toBe("before after a b");
    });
  });
});

describe("Codex service-tier domain projection", () => {
  test.each([null, undefined, "", " standard ", "default", "DEFAULT"])(
    "projects %p to Standard",
    (value) => {
      expect(normalizeCodexServiceTier(value)).toBeNull();
    },
  );

  test.each([
    ["priority", "fast"],
    [" PRIORITY ", "fast"],
    [" fast ", "fast"],
  ])("projects %p to Fast", (value, expected) => {
    expect(normalizeCodexServiceTier(value)).toBe(expected);
  });

  test("preserves any other named tier", () => {
    expect(normalizeCodexServiceTier(" flex ")).toBe("flex");
    expect(normalizeCodexServiceTier("ultrafast")).toBe("ultrafast");
  });
});

describe("offeredCodexServiceTier", () => {
  test("finds the id a model's catalog gives Fast", () => {
    expect(offeredCodexServiceTier(["default", "priority"], "fast")).toBe("priority");
    expect(offeredCodexServiceTier(["default", "fast"], "fast")).toBe("fast");
    expect(offeredCodexServiceTier(["default", "fast"], "priority")).toBe("fast");
  });

  test("prefers an exact id and reports a tier the model does not offer", () => {
    expect(offeredCodexServiceTier(["fast", "priority"], "priority")).toBe("priority");
    expect(offeredCodexServiceTier(["default", "flex"], "fast")).toBeNull();
    expect(offeredCodexServiceTier([], "fast")).toBeNull();
  });
});

describe("codexSpeedTiers", () => {
  test("lists the offered speeds slowest first by their Nodex names", () => {
    expect(codexSpeedTiers(["default", "ultrafast", "priority"])).toEqual(["fast", "ultrafast"]);
    expect(codexSpeedTiers(["default", "fast", "flex"])).toEqual(["fast"]);
    expect(codexSpeedTiers(["default"])).toEqual([]);
  });
});

describe("fitCodexServiceTier", () => {
  const sol = ["default", "priority", "ultrafast"];
  const astra = ["default", "priority"];

  test("keeps a tier the model offers, by the model's id", () => {
    expect(fitCodexServiceTier(sol, "ultrafast")).toBe("ultrafast");
    expect(fitCodexServiceTier(astra, "fast")).toBe("priority");
  });

  test("steps down to the fastest offered tier below the request", () => {
    expect(fitCodexServiceTier(astra, "ultrafast")).toBe("priority");
    expect(fitCodexServiceTier(["default"], "ultrafast")).toBeNull();
    expect(fitCodexServiceTier([], "fast")).toBeNull();
  });

  test("runs Standard and unknown tiers the model lacks at Standard", () => {
    expect(fitCodexServiceTier(sol, null)).toBeNull();
    expect(fitCodexServiceTier(sol, "flex")).toBeNull();
  });
});

describe("fitCodexServiceTierSelection", () => {
  test("fits by Nodex name and keeps a speed for a model the catalog does not describe", () => {
    expect(fitCodexServiceTierSelection(["default", "priority"], "ultrafast")).toBe("fast");
    expect(fitCodexServiceTierSelection(["default"], "fast")).toBeNull();
    expect(fitCodexServiceTierSelection(undefined, "ultrafast")).toBe("ultrafast");
    expect(fitCodexServiceTierSelection(undefined, "priority")).toBe("fast");
  });
});

describe("codex sidebar thread move", () => {
  function makeMove(placement: Record<string, unknown>) {
    return {
      hostId: "local",
      threadId: "thread-1",
      sourceContainerId: "project:alpha",
      targetContainerId: "project:beta",
      ...placement,
    };
  }

  describe("Codex sidebar thread move contract", () => {
    test("accepts each exact placement variant", () => {
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: "thread-2",
          }),
        ).success,
      ).toBe(true);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: null,
            afterThreadId: "thread-2",
          }),
        ).success,
      ).toBe(true);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: null,
            insertAtEnd: true,
          }),
        ).success,
      ).toBe(true);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: null,
            useDefaultOrder: true,
          }),
        ).success,
      ).toBe(true);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: null,
          }),
        ).success,
      ).toBe(true);
    });

    test("rejects ambiguous placement and malformed containers", () => {
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: null,
            afterThreadId: "thread-2",
            insertAtEnd: true,
          }),
        ).success,
      ).toBe(false);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: "thread-3",
            afterThreadId: "thread-2",
          }),
        ).success,
      ).toBe(false);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: null,
            insertAtEnd: true,
            useDefaultOrder: true,
          }),
        ).success,
      ).toBe(false);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse({
          ...makeMove({ beforeThreadId: null }),
          targetContainerId: "project:",
        }).success,
      ).toBe(false);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: "thread-1",
          }),
        ).success,
      ).toBe(false);
      expect(
        CodexSidebarThreadMoveInputSchema.safeParse(
          makeMove({
            beforeThreadId: null,
            afterThreadId: "thread-1",
          }),
        ).success,
      ).toBe(false);
    });

    test("projects every local container onto orthogonal membership and pin lanes", () => {
      expect(isCodexSidebarThreadContainerId("project:alpha")).toBe(true);
      expect(isCodexSidebarThreadContainerId("project-pinned:alpha")).toBe(true);
      expect(isCodexSidebarThreadContainerId("project:")).toBe(false);
      expect(isCodexSidebarThreadContainerId("project-pinned:")).toBe(false);
      expect(readCodexSidebarProjectContainerId("project:alpha")).toBe("alpha");
      expect(readCodexSidebarProjectContainerId("project-pinned:alpha")).toBe("alpha");
      expect(readCodexSidebarProjectContainerId("pinned")).toBe(null);
      expect(readCodexSidebarProjectContainerId("reorder-only:alpha")).toBe(null);
      expect(readCodexSidebarThreadContainerLocation("pinned")).toEqual({
        projectId: null,
        pinned: true,
      });
      expect(readCodexSidebarThreadContainerLocation("chats")).toEqual({
        projectId: null,
        pinned: false,
      });
      expect(readCodexSidebarThreadContainerLocation("project-pinned:alpha")).toEqual({
        projectId: "alpha",
        pinned: true,
      });
      expect(readCodexSidebarThreadContainerLocation("project:alpha")).toEqual({
        projectId: "alpha",
        pinned: false,
      });
      expect(readCodexSidebarThreadContainerLocation("cloud")).toBe(null);
      expect(codexSidebarProjectThreadContainerId("alpha", true)).toBe("project-pinned:alpha");
      expect(codexSidebarProjectThreadContainerId("alpha", false)).toBe("project:alpha");
    });
  });
});

describe("resolveCodexSubagentDisplayName", () => {
  test("prefers membership nickname over raw receiver thread ids", () => {
    const threadId = "019f3ce0-058c-7a51-8d13-6895cc7c4f6e";
    const membership: CodexConversationChildMembership = {
      threadId,
      parentThreadId: "thread-parent",
      role: "backgroundChild",
      actorName: threadId,
      thread: {
        nickname: "@Feynman",
        agentRole: "writer",
      },
    };
    const receiverThread: CodexMultiAgentReceiverThread = {
      threadId,
      thread: {
        displayName: threadId,
        nickname: null,
        model: null,
        agentRole: null,
      },
    };

    expect(resolveCodexSubagentDisplayName({ threadId, membership, receiverThread })).toBe(
      "Feynman",
    );
  });

  test("uses hydrated child summary nickname when opener payload is a uuid", () => {
    const threadId = "019f3ce0-c963-7a13-8d88-705e26cc1510";
    const childSummary: CodexThreadSummary = {
      threadId,
      projectId: null,
      source: { parentThreadId: "thread-parent" },
      ephemeral: false,
      threadSource: "subagent",
      agentNickname: "@Epicurus",
      agentRole: "runner",
      threadName: null,
      threadPreview: "Role/name: Command Runner",
      modelProvider: "openai",
      cwd: "/tmp/project",
      statusType: "idle",
      statusActiveFlags: [],
      hasUnreadTurn: false,
      threadRuntimeStatus: null,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      linkedAt: new Date(0).toISOString(),
    };

    expect(
      resolveCodexSubagentDisplayName({
        threadId,
        childSummary,
        fallbackDisplayName: threadId,
      }),
    ).toBe("Epicurus");
  });

  test("falls back to the conversation id when no friendly metadata exists", () => {
    expect(resolveCodexSubagentDisplayName({ threadId: "thread-child" })).toBe("thread-child");
  });
});

describe("codex-subagent-metadata", () => {
  test("extracts source thread_spawn metadata from both supported subagent source casings", () => {
    const camelCaseSource = extractCodexThreadSubagentMetadata({
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "parent-1",
            depth: 1,
            agent_path: "agents/@Scout",
            agent_nickname: "@Euclid",
            agent_role: "explorer",
          },
        },
      },
    });
    const protocolStyle = extractCodexThreadSubagentMetadata({
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent-2",
            depth: 2,
            agent_path: null,
            agent_nickname: "Nash",
            agent_role: "worker",
          },
        },
      },
    });

    expect(JSON.stringify(camelCaseSource)).toBe(
      JSON.stringify({
        parentThreadId: "parent-1",
        depth: 1,
        agentPath: "agents/@Scout",
        agentNickname: "@Euclid",
        agentRole: "explorer",
        hasParentThreadId: true,
        hasAgentNickname: true,
        hasAgentRole: true,
        hasAgentPath: true,
        hasAnySubagentSource: true,
      }),
    );
    expect(protocolStyle.parentThreadId).toBe("parent-2");
    expect(protocolStyle.agentNickname).toBe("Nash");
    expect(protocolStyle.agentRole).toBe("worker");
  });

  test("prefers top-level thread metadata while preserving source fallback presence", () => {
    const metadata = extractCodexThreadSubagentMetadata({
      parent_thread_id: "parent-top",
      agent_nickname: "Top",
      agent_role: "lead",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent-source",
            agent_nickname: "Source",
            agent_role: "worker",
          },
        },
      },
    });

    expect(metadata.parentThreadId).toBe("parent-top");
    expect(metadata.agentNickname).toBe("Top");
    expect(metadata.agentRole).toBe("lead");
    expect(metadata.hasAgentNickname).toBe(true);
    expect(metadata.hasAgentRole).toBe(true);
  });

  test("distinguishes missing metadata fields from explicit null source fields", () => {
    const missing = extractCodexThreadSubagentMetadata({
      id: "thread-1",
      source: "cli",
    });
    const explicitNulls = extractCodexThreadSubagentMetadata({
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent-1",
            agent_nickname: null,
            agent_role: null,
          },
        },
      },
    });
    const directSpawn = extractCodexThreadSpawnMetadata({
      thread_spawn: {
        parent_thread_id: "parent-direct",
        agent_nickname: "@Direct",
      },
    });

    expect(missing.hasAgentNickname).toBe(false);
    expect(missing.agentNickname).toBe(null);
    expect(explicitNulls.hasAgentNickname).toBe(true);
    expect(explicitNulls.agentNickname).toBe(null);
    expect(explicitNulls.hasAgentRole).toBe(true);
    expect(directSpawn.parentThreadId).toBe("parent-direct");
    expect(directSpawn.agentNickname).toBe("@Direct");
  });

  test("recognizes subagent source families that are not thread spawns", () => {
    const guardianSource = {
      subagent: {
        other: "guardian",
      },
    };
    const reviewSource = {
      subAgent: "review",
    };
    const cliSource = "cli";

    expect(hasCodexSubagentSource(guardianSource)).toBe(true);
    expect(getCodexSubagentOtherSource(guardianSource)).toBe("guardian");
    expect(hasCodexSubagentSource(reviewSource)).toBe(true);
    expect(getCodexSubagentOtherSource(reviewSource)).toBe(null);
    expect(hasCodexSubagentSource(cliSource)).toBe(false);
  });
});

describe("Codex subagent overview domain", () => {
  test("keeps unloaded Threads unresolved and projects active waiting flags", () => {
    expect(projectCodexSubagentThreadStatus({ statusType: "notLoaded", activeFlags: [] })).toBe(
      "unknown",
    );
    expect(
      projectCodexSubagentThreadStatus({
        statusType: "active",
        activeFlags: ["waitingOnUserInput"],
      }),
    ).toBe("waiting");
    expect(projectCodexSubagentThreadStatus({ statusType: "active", activeFlags: [] })).toBe(
      "active",
    );
    expect(projectCodexSubagentThreadStatus({ statusType: "idle", activeFlags: [] })).toBe("done");
    expect(isCodexSubagentUnresolvedStatus("unknown")).toBe(true);
  });

  test("rejects weak and stale evidence while allowing a later notification to reopen work", () => {
    const completion: CodexSubagentStatusEvidence = {
      status: "done",
      kind: "completion",
      sourceRevision: 12,
      observedAtMs: 120,
    };
    const staleMetadata: CodexSubagentStatusEvidence = {
      status: "unknown",
      kind: "metadata",
      sourceRevision: 99,
      observedAtMs: 130,
    };
    const nextTurn: CodexSubagentStatusEvidence = {
      status: "active",
      kind: "notification",
      sourceRevision: 13,
      observedAtMs: 140,
    };

    expect(selectCodexSubagentStatusEvidence(completion, staleMetadata)).toEqual(completion);
    expect(selectCodexSubagentStatusEvidence(completion, nextTurn)).toEqual(nextTurn);
    expect(
      selectCodexSubagentStatusEvidence(completion, {
        ...nextTurn,
        sourceRevision: 1,
        observedAtMs: completion.observedAtMs + 1,
      }),
    ).toEqual(completion);
    expect(
      selectCodexSubagentStatusEvidence(
        { ...completion, sourceRevision: 199, observedAtMs: 1_785_000_001_000 },
        { ...nextTurn, sourceRevision: 200, observedAtMs: 1_784_000_000_000 },
      ),
    ).toEqual({ ...nextTurn, sourceRevision: 200, observedAtMs: 1_784_000_000_000 });
    const reconciled: CodexSubagentStatusEvidence = {
      status: "done",
      kind: "reconciliation",
      sourceRevision: 0,
      observedAtMs: 1,
    };
    expect(selectCodexSubagentStatusEvidence(nextTurn, reconciled)).toEqual(reconciled);
    expect(
      selectCodexSubagentStatusEvidence(reconciled, {
        ...nextTurn,
        sourceRevision: 14,
        observedAtMs: 0,
      }),
    ).toMatchObject({ status: "active", kind: "notification", sourceRevision: 14 });
  });
});
