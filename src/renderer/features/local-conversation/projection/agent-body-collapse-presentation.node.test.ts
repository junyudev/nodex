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
  type: "exec" | "userMessage" | "contextCompaction",
  entryOverrides: Partial<CodexConversationItem> = {},
): ThreadAgentRenderUnit {
  const entry: CodexConversationItem = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    type: type === "userMessage" ? "user_message" : "command_execution",
    kind:
      type === "userMessage"
        ? "userMessage"
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

    expect(presentation.expandedUnits).toBe(units);
    expect(presentation.collapsibleUnits).toEqual([exec]);
    expect(presentation.persistentUnits).toEqual(messages);
    expect(presentation.workedForItem).toBeNull();
    expect(countAgentBodyUnits(presentation.collapsibleUnits)).toBe(1);
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
    expect(presentation.expandedUnits).toEqual([exec]);
    expect(presentation.collapsibleUnits).toEqual([exec]);
    expect(presentation.persistentUnits).toEqual([]);
  });
});
