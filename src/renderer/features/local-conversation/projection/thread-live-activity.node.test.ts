import { describe, expect, it } from "vite-plus/test";
import type {
  ThreadAgentActivityUnit,
  ThreadAgentItemModel,
  ThreadTranscriptBlockModel,
} from "../thread-stage-types";
import type { ThreadClassifiableActivityItem } from "./agent-activity-v2";
import {
  resolveThreadActivityGroupState,
  resolveThreadParentActivityPresentation,
  type ResolveThreadParentActivityInput,
} from "./thread-live-activity";

function reasoning(markdownText: string): ThreadTranscriptBlockModel {
  return {
    id: "reasoning-1",
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 2,
    searchableText: "",
    type: "reasoning",
    status: "inProgress",
    entry: {
      itemId: "reasoning-1",
      threadId: "thread-1",
      turnId: "turn-1",
      type: "reasoning",
      kind: "reasoning",
      semanticKind: "reasoning",
      createdAt: 1,
      updatedAt: 2,
      markdownText,
    },
  };
}

function exec(status: "completed" | "inProgress" = "completed"): ThreadClassifiableActivityItem {
  return {
    id: `exec-${status}`,
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 2,
    searchableText: "pnpm test",
    type: "exec",
    status,
    entry: {
      itemId: `exec-${status}`,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "command_execution",
      kind: "commandExecution",
      semanticKind: "exec",
      status,
      createdAt: 1,
      updatedAt: 2,
      executionStatus: status,
      parsedCmd: {
        type: "unknown",
        cmd: "pnpm test",
        isFinished: status === "completed",
      },
    },
  };
}

function groupUnit(
  ...items: ThreadClassifiableActivityItem[]
): Extract<ThreadAgentActivityUnit<ThreadClassifiableActivityItem>, { kind: "group" }> {
  const first = items[0];
  if (!first) throw new Error("group fixture requires an item");
  return {
    kind: "group",
    key: "group",
    items: [
      { item: first, grouping: "groupable" },
      ...items.slice(1).map((item) => ({ item, grouping: "groupable" as const })),
    ],
  };
}

function parentInput(
  overrides: Partial<ResolveThreadParentActivityInput> = {},
): ResolveThreadParentActivityInput {
  return {
    isLatestTurn: true,
    isTurnInProgress: true,
    isBlocked: false,
    showSafetyBufferingUi: false,
    assistantItem: null,
    proposedPlanItem: null,
    agentItems: [],
    activityUnits: [],
    isExploring: false,
    hasBlockingRequest: false,
    hasPendingGeneratedOutput: false,
    hasPostAssistantUnits: false,
    ...overrides,
  };
}

describe("resolveThreadParentActivityPresentation", () => {
  it("lets an active recovery row replace generic thinking, then restores thinking after recovery", () => {
    const retry: ThreadTranscriptBlockModel = {
      ...reasoning(""),
      type: "streamError",
      entry: {
        ...reasoning("").entry,
        recovery: {
          state: "retrying",
          reason: "unknown",
          attempt: null,
          maxAttempts: null,
          retryAt: null,
          updatedAt: null,
        },
      },
    };
    const input = parentInput({
      agentItems: [retry],
      assistantItem: { ...reasoning("Preparing a change"), type: "assistantMessage" },
    });
    const pending = resolveThreadParentActivityPresentation(input);
    expect(pending.global.reason).toBe("provider-recovery");
    expect(pending.fallback.isVisible).toBe(false);
    retry.entry.recovery = { ...retry.entry.recovery!, state: "recovered" };
    expect(resolveThreadParentActivityPresentation(input).fallback.isVisible).toBe(true);
  });

  it("assigns a reasoning-only turn to the standalone fallback", () => {
    const result = resolveThreadParentActivityPresentation(
      parentInput({
        agentItems: [reasoning("**Reading the bundle.**")],
      }),
    );

    expect(result).toMatchObject({
      global: {
        state: { type: "thinking", isVisible: true },
        reason: "between-activities",
      },
      mainSlice: {
        state: { kind: "open", reason: "turn-streaming" },
        latestVisibleUnit: null,
      },
      fallback: {
        owner: "standalone",
        reason: "global-thinking",
        message: "Reading the bundle.",
        isVisible: true,
      },
      reasoningSummary: { text: "Reading the bundle." },
    });
  });

  it("gives a completed latest group exclusive ownership of the reasoning heading", () => {
    const unit = groupUnit(exec("completed"));
    const result = resolveThreadParentActivityPresentation(
      parentInput({
        agentItems: [
          exec("completed") as ThreadAgentItemModel,
          reasoning("**Preparing a patch.**"),
        ],
        activityUnits: [unit],
      }),
    );

    expect(result.fallback).toMatchObject({
      owner: "group",
      reason: "latest-open-group",
      message: "Preparing a patch.",
    });
    expect(
      resolveThreadActivityGroupState({
        unit,
        unitIndex: 0,
        unitCount: 1,
        parent: result,
        isTurnInProgress: true,
        isExploring: false,
      }).kind,
    ).toBe("thinking");
  });

  it("lets a strict-active tool own its concrete header without a thinking owner", () => {
    const unit = groupUnit(exec("inProgress"));
    const result = resolveThreadParentActivityPresentation(
      parentInput({
        agentItems: [
          exec("inProgress") as ThreadAgentItemModel,
          reasoning("**Must not replace the tool.**"),
        ],
        activityUnits: [unit],
      }),
    );

    expect(result).toMatchObject({
      global: {
        state: { type: "none" },
        reason: "active-tool",
      },
      fallback: {
        owner: "none",
        reason: "global-state-suppressed",
        message: null,
      },
    });
    expect(
      resolveThreadActivityGroupState({
        unit,
        unitIndex: 0,
        unitCount: 1,
        parent: result,
        isTurnInProgress: true,
        isExploring: false,
      }).kind,
    ).toBe("active");
  });

  it("suppresses fallback ownership for blocking, safety, pending output, and planning", () => {
    const cases = [
      parentInput({ isBlocked: true, hasBlockingRequest: true }),
      parentInput({ showSafetyBufferingUi: true }),
      parentInput({ hasPendingGeneratedOutput: true }),
      parentInput({
        proposedPlanItem: {
          ...reasoning("plan"),
          id: "plan",
          type: "proposedPlan",
          status: "inProgress",
        },
      }),
    ];

    const results = cases.map(resolveThreadParentActivityPresentation);
    expect(results.map((result) => result.fallback.owner).join(",")).toBe("none,none,none,none");
    expect(results.map((result) => result.mainSlice.state.kind).join(",")).toBe(
      "closed,closed,closed,closed",
    );
    expect(results.map((result) => result.mainSlice.state.reason)).toEqual([
      "blocking-request",
      "safety-buffering",
      "pending-generated-output",
      "planning",
    ]);
    expect(results[3]?.global.state.type).toBe("planning");
  });

  it("moves thinking after visible commentary but suppresses it after final output", () => {
    const commentary = {
      ...reasoning("commentary"),
      id: "commentary",
      type: "assistantMessage" as const,
      entry: {
        ...reasoning("commentary").entry,
        assistantPhase: "commentary" as const,
        markdownText: "I am checking the repository.",
      },
    };
    const finalAnswer = {
      ...commentary,
      id: "final",
      status: "inProgress" as const,
      entry: {
        ...commentary.entry,
        assistantPhase: "final_answer" as const,
        markdownText: "Done.",
      },
    };

    expect(
      resolveThreadParentActivityPresentation(parentInput({ assistantItem: commentary })),
    ).toMatchObject({
      global: {
        state: { type: "none" },
        reason: "assistant-visible-output",
      },
      mainSlice: {
        state: { kind: "closed", reason: "assistant-visible-output" },
      },
      fallback: {
        owner: "standalone",
        reason: "post-assistant-thinking",
        isVisible: true,
      },
    });
    expect(
      resolveThreadParentActivityPresentation(parentInput({ assistantItem: finalAnswer })),
    ).toMatchObject({
      global: {
        state: { type: "none" },
        reason: "assistant-visible-output",
      },
      mainSlice: {
        state: { kind: "closed", reason: "assistant-visible-output" },
      },
      fallback: {
        owner: "none",
        reason: "global-state-suppressed",
      },
    });
  });

  it("suppresses post-assistant thinking when a post-assistant unit owns the surface", () => {
    const commentary = {
      ...reasoning("commentary"),
      id: "commentary",
      type: "assistantMessage" as const,
      entry: {
        ...reasoning("commentary").entry,
        assistantPhase: "commentary" as const,
        markdownText: "I am checking the repository.",
      },
    };

    expect(
      resolveThreadParentActivityPresentation(
        parentInput({
          assistantItem: commentary,
          hasPostAssistantUnits: true,
        }),
      ).fallback,
    ).toMatchObject({
      owner: "none",
      reason: "global-state-suppressed",
    });
  });

  it("closes stale and settled slices with explicit diagnostic reasons", () => {
    const stale = resolveThreadParentActivityPresentation(parentInput({ isLatestTurn: false }));
    const settled = resolveThreadParentActivityPresentation(
      parentInput({ isTurnInProgress: false }),
    );

    expect(stale).toMatchObject({
      global: { state: { type: "none" }, reason: "not-latest-turn" },
      mainSlice: { state: { kind: "closed", reason: "not-latest-turn" } },
      fallback: { owner: "none" },
    });
    expect(settled).toMatchObject({
      global: { state: { type: "none" }, reason: "turn-settled" },
      mainSlice: { state: { kind: "closed", reason: "turn-settled" } },
      fallback: { owner: "none" },
    });
  });
});
