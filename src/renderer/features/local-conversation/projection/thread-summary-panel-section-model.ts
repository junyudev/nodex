import { getIntl } from "@/lib/i18n";
import type { ThreadComposerShellBackgroundAgentRowModel } from "../thread-stage-types";
import { getBackgroundSubagentListRows } from "./background-subagent-summary-model";

export type ThreadSummaryPanelSectionKind =
  | "automations"
  | "environment"
  | "folder"
  | "plan"
  | "outputs"
  | "followUps"
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
  hasAutomation: boolean;
  hasEnvironment: boolean;
  /** A chat in no Project shows the Chat folder it works in. */
  hasFolder?: boolean;
  hasPlan: boolean;
  outputCount: number;
  /** Inbox messages the chat's Agents left, and how many still wait for a decision. */
  followUpCount?: number;
  openFollowUpCount?: number;
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
    title: getIntl().formatMessage({
      id: "conversation.threadSummaryPanelSectionModel.subagents",
      defaultMessage: "Subagents",
    }),
    mode: "accordion",
    count: hasInlineActivity ? null : listRows.length,
    autoCollapse: !hasInlineActivity && rows.every((row) => row.status === "done"),
  };
}

export function buildThreadSummaryPanelSectionModel(
  input: ThreadSummaryPanelSectionModelInput,
): ThreadSummaryPanelSectionModel[] {
  const sections: Array<ThreadSummaryPanelSectionModel | null> = [
    input.hasAutomation
      ? {
          kind: "automations",
          sectionKey: "automation",
          title: getIntl().formatMessage({
            id: "conversation.threadSummaryPanelSectionModel.automations",
            defaultMessage: "Automations",
          }),
          mode: "accordion",
          count: null,
          autoCollapse: false,
        }
      : null,
    input.hasEnvironment
      ? {
          kind: "environment",
          sectionKey: "environment",
          title: getIntl().formatMessage({
            id: "conversation.threadSummaryPanelSectionModel.environment",
            defaultMessage: "Environment",
          }),
          mode: "accordion",
          count: null,
          autoCollapse: false,
        }
      : null,
    input.hasFolder
      ? {
          kind: "folder",
          sectionKey: "folder",
          title: getIntl().formatMessage({
            id: "conversation.threadSummaryPanelSectionModel.folder",
            defaultMessage: "Folder",
          }),
          mode: "accordion",
          count: null,
          autoCollapse: false,
        }
      : null,
    input.hasPlan
      ? {
          kind: "plan",
          sectionKey: "plan",
          title: getIntl().formatMessage({
            id: "conversation.threadSummaryPanelSectionModel.plan",
            defaultMessage: "Plan",
          }),
          mode: "accordion",
          count: null,
          autoCollapse: false,
        }
      : null,
    input.outputCount > 0
      ? {
          kind: "outputs",
          sectionKey: "artifacts",
          title: getIntl().formatMessage({
            id: "conversation.threadSummaryPanelSectionModel.outputs",
            defaultMessage: "Outputs",
          }),
          mode: "accordion",
          count: input.outputCount,
          autoCollapse: false,
        }
      : null,
    (input.followUpCount ?? 0) > 0
      ? {
          kind: "followUps",
          sectionKey: "follow-ups",
          title: getIntl().formatMessage({
            id: "conversation.threadSummaryPanelSectionModel.followUps",
            defaultMessage: "Follow-ups",
          }),
          mode: "accordion",
          count: input.openFollowUpCount ?? 0,
          autoCollapse: false,
        }
      : null,
    countSection(
      "sideChats",
      "side-chats",
      getIntl().formatMessage({
        id: "conversation.threadSummaryPanelSectionModel.sideChats",
        defaultMessage: "Side chats",
      }),
      input.sideChatCount,
    ),
    buildSubagentsSection(input.backgroundSubagentRows),
    countSection(
      "tasks",
      "background-tasks",
      getIntl().formatMessage({
        id: "conversation.threadSummaryPanelSectionModel.background",
        defaultMessage: "Background",
      }),
      input.taskCount,
    ),
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
    countSection(
      "browser",
      "browser-tabs",
      getIntl().formatMessage({
        id: "conversation.threadSummaryPanelSectionModel.browser",
        defaultMessage: "Browser",
      }),
      input.browserCount,
    ),
    {
      kind: "sources",
      sectionKey: "tool-sources",
      title: getIntl().formatMessage({
        id: "conversation.threadSummaryPanelSectionModel.sources",
        defaultMessage: "Sources",
      }),
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
