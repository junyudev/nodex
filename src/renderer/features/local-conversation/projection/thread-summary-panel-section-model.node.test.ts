import { describe, expect, test } from "vite-plus/test";
import {
  buildThreadSummaryPanelSectionModel,
  hasThreadSummaryPanelSection,
  type ThreadSummaryPanelSectionKind,
} from "./thread-summary-panel-section-model";

function sectionKinds(
  input: Parameters<typeof buildThreadSummaryPanelSectionModel>[0],
): ThreadSummaryPanelSectionKind[] {
  return buildThreadSummaryPanelSectionModel(input).map((section) => section.kind);
}

describe("buildThreadSummaryPanelSectionModel", () => {
  test("keeps the Codex summary section order and gates empty optional sections", () => {
    const kinds = sectionKinds({
      activeThreadId: "thread-1",
      hasScheduledAutomation: true,
      hasEnvironment: true,
      hasPlan: true,
      outputCount: 2,
      suppressOutputs: false,
      sideChatCount: 1,
      backgroundSubagentRows: [
        { displayName: "Scout", showInlineActivity: false, status: "active" },
      ],
      taskCount: 1,
      hasComputerUsePip: true,
      browserCount: 1,
      sourceCount: 3,
    });

    expect(kinds.join(",")).toBe(
      "scheduled,environment,plan,outputs,sideChats,subagents,tasks,computerUsePip,browser,sources",
    );
  });

  test("suppresses outputs behind the git environment summary gate", () => {
    const sections = buildThreadSummaryPanelSectionModel({
      activeThreadId: "thread-1",
      hasScheduledAutomation: false,
      hasEnvironment: true,
      hasPlan: false,
      outputCount: 1,
      suppressOutputs: true,
      sideChatCount: 0,
      backgroundSubagentRows: [],
      taskCount: 0,
      hasComputerUsePip: false,
      browserCount: 0,
      sourceCount: 0,
    });

    expect(hasThreadSummaryPanelSection(sections, "outputs")).toBe(false);
    expect(sections.map((section) => section.kind).join(",")).toBe("environment,sources");
  });

  test("hides the Environment section when no git environment summary is available", () => {
    const sections = buildThreadSummaryPanelSectionModel({
      activeThreadId: "thread-1",
      hasScheduledAutomation: false,
      hasEnvironment: false,
      hasPlan: false,
      outputCount: 1,
      suppressOutputs: false,
      sideChatCount: 0,
      backgroundSubagentRows: [],
      taskCount: 0,
      hasComputerUsePip: false,
      browserCount: 0,
      sourceCount: 0,
    });

    expect(hasThreadSummaryPanelSection(sections, "environment")).toBe(false);
    expect(sections.map((section) => section.kind).join(",")).toBe("outputs,sources");
  });

  test("marks completed non-inline subagents for auto-collapse", () => {
    const sections = buildThreadSummaryPanelSectionModel({
      activeThreadId: "thread-1",
      hasScheduledAutomation: false,
      hasEnvironment: false,
      hasPlan: false,
      outputCount: 0,
      suppressOutputs: false,
      sideChatCount: 0,
      backgroundSubagentRows: [
        { displayName: "Scout", showInlineActivity: false, status: "done" },
        { displayName: "Scout", showInlineActivity: false, status: "done" },
      ],
      taskCount: 0,
      hasComputerUsePip: false,
      browserCount: 0,
      sourceCount: 0,
    });

    const subagents = sections.find((section) => section.kind === "subagents");
    expect(subagents?.count).toBe(2);
    expect(subagents?.autoCollapse).toBe(true);
  });

  test("hides the Subagents header count when inline activity owns the compact summary", () => {
    const sections = buildThreadSummaryPanelSectionModel({
      activeThreadId: "thread-1",
      hasScheduledAutomation: false,
      hasEnvironment: false,
      hasPlan: false,
      outputCount: 0,
      suppressOutputs: false,
      sideChatCount: 0,
      backgroundSubagentRows: [
        { displayName: "Scout", showInlineActivity: true, status: "done" },
        { displayName: "Scout", showInlineActivity: false, status: "done" },
      ],
      taskCount: 0,
      hasComputerUsePip: false,
      browserCount: 0,
      sourceCount: 0,
    });

    const subagents = sections.find((section) => section.kind === "subagents");
    expect(subagents?.count ?? "null").toBe("null");
    expect(subagents?.autoCollapse).toBe(false);
  });

  test("keeps Sources and blank-thread hint as explicit model entries", () => {
    const sections = buildThreadSummaryPanelSectionModel({
      activeThreadId: null,
      hasScheduledAutomation: false,
      hasEnvironment: false,
      hasPlan: false,
      outputCount: 0,
      suppressOutputs: false,
      sideChatCount: 0,
      backgroundSubagentRows: [],
      taskCount: 0,
      hasComputerUsePip: false,
      browserCount: 0,
      sourceCount: 0,
    });

    expect(sections.map((section) => section.kind).join(",")).toBe("sources,emptyHint");
    expect(sections.find((section) => section.kind === "sources")?.count).toBe(0);
    expect(sections.find((section) => section.kind === "emptyHint")?.mode).toBe("headerless");
  });
});
