import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationItem } from "../../../lib/types";
import type {
  ThreadAgentRenderUnit,
  ThreadTranscriptBlockModel,
  ThreadWorkedForBlockModel,
} from "../thread-stage-types";
import {
  countAgentBodyUnits,
  projectAgentBodyCollapsePresentation,
} from "./agent-body-collapse-presentation";

function buildEntryUnit(
  id: string,
  type:
    | "exec"
    | "userMessage"
    | "assistantMessage"
    | "contextCompaction"
    | "streamError"
    | "systemError",
  entryOverrides: Partial<CodexConversationItem> = {},
): ThreadAgentRenderUnit {
  const entry: CodexConversationItem = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    type:
      type === "userMessage"
        ? "user_message"
        : type === "assistantMessage"
          ? "assistant_message"
          : "command_execution",
    kind:
      type === "userMessage" || type === "assistantMessage"
        ? type
        : type === "contextCompaction"
          ? "systemEvent"
          : "commandExecution",
    semanticKind: type,
    createdAt: 1,
    updatedAt: 1,
    ...entryOverrides,
  };
  const block: ThreadTranscriptBlockModel = {
    id,
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 1,
    searchableText: "",
    type,
    entry,
  };

  return { kind: "entry", block };
}

describe("agent body collapse presentation", () => {
  test("keeps recovery outside collapsed work without counting it as an agent message", () => {
    const exec = buildEntryUnit("exec", "exec");
    const states = ["retrying", "recovered", "failed", "stopped"] as const;
    for (const state of states) {
      const recovery = buildEntryUnit(
        "recovery",
        state === "failed" ? "systemError" : "streamError",
        {
          recovery: {
            state,
            reason: "unknown",
            attempt: null,
            maxAttempts: null,
            retryAt: null,
            updatedAt: null,
          },
        },
      );
      const presentation = projectAgentBodyCollapsePresentation([exec, recovery]);
      expect(presentation.bodyUnits).toEqual([
        { unit: exec, persistent: false },
        { unit: recovery, persistent: true },
      ]);
      expect(presentation.collapsibleUnits).toEqual([exec]);
      expect(countAgentBodyUnits(presentation.collapsibleUnits)).toBe(1);
      expect(projectAgentBodyCollapsePresentation([recovery]).canCollapse).toBe(false);
    }
  });

  test("never collapses work that is only one context compaction", () => {
    const compaction = buildEntryUnit("compaction", "contextCompaction");
    const steeringMessage = buildEntryUnit("steering", "userMessage", {
      steeringStatus: "accepted",
    });

    expect(projectAgentBodyCollapsePresentation([compaction]).canCollapse).toBe(false);
    expect(projectAgentBodyCollapsePresentation([compaction, steeringMessage]).canCollapse).toBe(
      false,
    );
    expect(
      projectAgentBodyCollapsePresentation([compaction, buildEntryUnit("exec", "exec")])
        .canCollapse,
    ).toBe(true);
    expect(projectAgentBodyCollapsePresentation([]).canCollapse).toBe(false);
  });

  test("keeps complete user messages persistent regardless of delivery path", () => {
    const exec = buildEntryUnit("exec", "exec");
    const ordinaryUserMessage = buildEntryUnit("ordinary-user", "userMessage");
    const steeringMessage = buildEntryUnit("steering", "userMessage", {
      steeringStatus: "accepted",
    });
    const hookFeedbackMessage = buildEntryUnit("hook-feedback", "userMessage", {
      hookFeedback: true,
    });
    const runtimeSteer = buildEntryUnit("runtime-steer", "userMessage", {
      userInputIntent: "steer",
    });
    const promotedSteer = buildEntryUnit("promoted-steer", "userMessage", {
      userInputIntent: "promotedToSteer",
    });
    const messages = [
      steeringMessage,
      ordinaryUserMessage,
      hookFeedbackMessage,
      runtimeSteer,
      promotedSteer,
    ];
    const units = [exec, ...messages];

    const presentation = projectAgentBodyCollapsePresentation(units);

    expect(presentation.bodyUnits).toEqual([
      { unit: exec, persistent: false },
      ...messages.map((unit) => ({ unit, persistent: true })),
    ]);
    expect(presentation.collapsibleUnits).toEqual([exec]);
    expect(presentation.workedForItem).toBeNull();
    expect(countAgentBodyUnits(presentation.collapsibleUnits)).toBe(1);
  });

  test("keeps the Turn's reply visible when later work holds it inside the collapsed body", () => {
    const exec = buildEntryUnit("exec", "exec");
    const reply = buildEntryUnit("reply", "assistantMessage", { markdownText: "Done" });
    const delegated = buildEntryUnit("delegated", "exec");
    const units = [exec, reply, delegated];

    const presentation = projectAgentBodyCollapsePresentation(units, { replyBlockId: "reply" });

    // The reply keeps its canonical place between the work that folds around it.
    expect(presentation.bodyUnits).toEqual([
      { unit: exec, persistent: false },
      { unit: reply, persistent: true },
      { unit: delegated, persistent: false },
    ]);
    expect(presentation.collapsibleUnits).toEqual([exec, delegated]);
    expect(presentation.canCollapse).toBe(true);
    expect(projectAgentBodyCollapsePresentation(units).collapsibleUnits).toEqual(units);
  });

  test("extracts worked time as the sole collapse label source", () => {
    const workedFor: ThreadWorkedForBlockModel = {
      id: "worked-for",
      turnId: "turn-1",
      createdAt: 2,
      updatedAt: 3,
      searchableText: "Worked for 1s",
      type: "workedFor",
      status: "worked",
      startedAtMs: 2_000,
      completedAtMs: 3_000,
    };
    const exec = buildEntryUnit("exec", "exec");
    const units: ThreadAgentRenderUnit[] = [{ kind: "entry", block: workedFor }, exec];

    const presentation = projectAgentBodyCollapsePresentation(units, {
      extractWorkedFor: true,
    });

    expect(presentation.workedForItem).toBe(workedFor);
    expect(presentation.bodyUnits).toEqual([{ unit: exec, persistent: false }]);
    expect(presentation.collapsibleUnits).toEqual([exec]);
  });
});
