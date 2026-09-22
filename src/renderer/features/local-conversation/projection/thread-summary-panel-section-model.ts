import type { ThreadComposerShellBackgroundAgentRowModel } from "../thread-stage-types";
import { getBackgroundSubagentListRows } from "./background-subagent-summary-model";

export type ThreadSummaryPanelSectionKind =
  | "scheduled"
  | "environment"
  | "plan"
  | "outputs"
  | "sideChats"
  | "subagents"
  | "tasks"
  | "computerUsePip"
  | "browser"
  | "sources"
  | "emptyHint";

export type ThreadSummaryPanelSectionMode = "accordion" | "headerless";

export interface ThreadSummaryPanelSectionModel {
  kind: ThreadSummaryPanelSectionKind;
  sectionKey: string | null;
  title: string | null;
  mode: ThreadSummaryPanelSectionMode;
  count: number | null;
  autoCollapse: boolean;
}

export interface ThreadSummaryPanelSectionModelInput {
  activeThreadId: string | null;
  hasScheduledAutomation: boolean;
  hasEnvironment: boolean;
  hasPlan: boolean;
  outputCount: number;
  suppressOutputs: boolean;
  sideChatCount: number;
  backgroundSubagentRows: readonly Pick<
    ThreadComposerShellBackgroundAgentRowModel,
    "showInlineActivity" | "status" | "displayName"
  >[];
  taskCount: number;
  hasComputerUsePip: boolean;
  browserCount: number;
  sourceCount: number;
}

function countSection(
  kind: ThreadSummaryPanelSectionKind,
  sectionKey: string,
  title: string,
  count: number,
): ThreadSummaryPanelSectionModel | null {
  if (count <= 0) return null;

  return {
    kind,
    sectionKey,
    title,
    mode: "accordion",
    count,
    autoCollapse: false,
  };
}

function buildSubagentsSection(
  rows: ThreadSummaryPanelSectionModelInput["backgroundSubagentRows"],
): ThreadSummaryPanelSectionModel | null {
  rows = rows.filter((row) => row.displayName.trim().length > 0);
  if (rows.length === 0) return null;

  const hasInlineActivity = rows.some((row) => row.showInlineActivity);
  const listRows = getBackgroundSubagentListRows(rows);
  return {
    kind: "subagents",
    sectionKey: "background-subagents",
    title: "Subagents",
    mode: "accordion",
    count: hasInlineActivity ? null : listRows.length,
    autoCollapse: !hasInlineActivity && rows.every((row) => row.status === "done"),
  };
}

export function buildThreadSummaryPanelSectionModel(
  input: ThreadSummaryPanelSectionModelInput,
): ThreadSummaryPanelSectionModel[] {
  const sections: Array<ThreadSummaryPanelSectionModel | null> = [
    input.hasScheduledAutomation
      ? {
          kind: "scheduled",
          sectionKey: "automation",
          title: "Scheduled",
          mode: "accordion",
          count: null,
          autoCollapse: false,
        }
      : null,
    input.hasEnvironment
      ? {
          kind: "environment",
          sectionKey: "environment",
          title: "Environment",
          mode: "accordion",
          count: null,
          autoCollapse: false,
        }
      : null,
    input.hasPlan
      ? {
          kind: "plan",
          sectionKey: "plan",
          title: "Plan",
          mode: "accordion",
          count: null,
          autoCollapse: false,
        }
      : null,
    input.outputCount > 0 && !input.suppressOutputs
      ? {
          kind: "outputs",
          sectionKey: "artifacts",
          title: "Outputs",
          mode: "accordion",
          count: input.outputCount,
          autoCollapse: false,
        }
      : null,
    countSection("sideChats", "side-chats", "Side chats", input.sideChatCount),
    buildSubagentsSection(input.backgroundSubagentRows),
    countSection("tasks", "background-tasks", "Tasks", input.taskCount),
    input.hasComputerUsePip
      ? {
          kind: "computerUsePip",
          sectionKey: "computer-use-pip",
          title: null,
          mode: "headerless",
          count: null,
          autoCollapse: false,
        }
      : null,
    countSection("browser", "browser-tabs", "Browser", input.browserCount),
    {
      kind: "sources",
      sectionKey: "tool-sources",
      title: "Sources",
      mode: "accordion",
      count: input.sourceCount,
      autoCollapse: false,
    },
    input.activeThreadId
      ? null
      : {
          kind: "emptyHint",
          sectionKey: null,
          title: null,
          mode: "headerless",
          count: null,
          autoCollapse: false,
        },
  ];

  return sections.filter((section): section is ThreadSummaryPanelSectionModel => section !== null);
}

export function hasThreadSummaryPanelSection(
  sections: readonly ThreadSummaryPanelSectionModel[],
  kind: ThreadSummaryPanelSectionKind,
): boolean {
  return sections.some((section) => section.kind === kind);
}
