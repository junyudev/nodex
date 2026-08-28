import type { DatabasePage } from "../../../lib/types";
import { plainTextToPortableRichText } from "../../../../shared/block-documents";
import type { PageStageRelatedChat } from "./types";

export type PageStageStoryChatDensity = "none" | "few" | "many";
export const PAGE_STAGE_STORY_CHAT_DENSITIES = ["none", "few", "many"] as const;

export interface PageStageStoryControls {
  chatDensity: PageStageStoryChatDensity;
  showNewChatAction: boolean;
  enableOpenChat: boolean;
  historyPanelActive: boolean;
}

export interface PageStageStoryPreset {
  id: string;
  name: string;
  description: string;
  controls: PageStageStoryControls;
}

export const PAGE_STAGE_STORY_PROJECT_ID = "nodex";
export const PAGE_STAGE_STORY_COLUMN_ID = "6-in-progress";
export const PAGE_STAGE_STORY_COLUMN_NAME = "Build";
export const PAGE_STAGE_STORY_WORKSPACE_PATH = "/workspace/nodex";

export const PAGE_STAGE_STORY_PRESETS: PageStageStoryPreset[] = [
  {
    id: "overview",
    name: "Overview",
    description:
      "Balanced page stage with related Chats, tags, schedule, and all major chrome visible.",
    controls: {
      chatDensity: "few",
      showNewChatAction: true,
      enableOpenChat: true,
      historyPanelActive: false,
    },
  },
  {
    id: "dense-chats",
    name: "Dense Chats",
    description: "Long related-Chat stack to refine truncation, spacing, and activity states.",
    controls: {
      chatDensity: "many",
      showNewChatAction: true,
      enableOpenChat: true,
      historyPanelActive: false,
    },
  },
  {
    id: "empty-chats",
    name: "Empty Chats",
    description: "Empty relation state with the compact Add chat value action.",
    controls: {
      chatDensity: "none",
      showNewChatAction: true,
      enableOpenChat: true,
      historyPanelActive: false,
    },
  },
];

export const PAGE_STAGE_STORY_DEFAULT_PRESET = PAGE_STAGE_STORY_PRESETS[0];

function countForDensity(density: PageStageStoryChatDensity): number {
  if (density === "few") return 3;
  if (density === "many") return 10;
  return 0;
}

export function buildPageStageStoryChats(
  controls: Pick<PageStageStoryControls, "chatDensity">,
  extraChatCount = 0,
): PageStageRelatedChat[] {
  const total = Math.max(0, countForDensity(controls.chatDensity) + Math.max(0, extraChatCount));

  return Array.from({ length: total }, (_, index) => ({
    sessionId: `story-session-${index + 1}`,
    projectId: PAGE_STAGE_STORY_PROJECT_ID,
    projectName: "Nodex",
    threadId: index === total - 1 ? null : `story-thread-${index + 1}`,
    displayTitle:
      index === 0
        ? "Polish related Chat affordances"
        : `Page detail iteration ${String(index + 1).padStart(2, "0")}`,
    threadPreview: "",
    threadStatus:
      index === total - 1 ? null : { statusType: index === 0 ? "active" : "idle", activeFlags: [] },
    threadArchived: false,
    unread: index === 0,
    sessionArchived: false,
    conversationRecencyAt: Date.now() - (index + 1) * 60_000,
    linkedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
  }));
}

export function buildPageStageStoryPage(): DatabasePage {
  return {
    id: "story-page-stage-1",
    pageKey: "LAB-13",
    status: "build",
    archived: false,
    title: "Refine related Chat property UI",
    richTitle: plainTextToPortableRichText("Refine related Chat property UI"),
    description: [
      "## Story intent",
      "",
      "Use this development-only surface to iterate on the page stage without opening a real project page.",
      "Focus on the **Linked chats** Property: wrapping chips, activity states, and its trailing add action.",
      "",
      "- Verify truncation for long Chat titles",
      "- Compare empty, sparse, and dense related-Chat stacks",
      "- Verify New chat and Link to chat stay available without consuming another row",
      "",
      "### Notes",
      "The save handlers are mocked, so this story is safe to edit locally while refining layout.",
    ].join("\n"),
    priority: "p1-high",
    estimate: "m",
    tags: ["ui", "chats", "page-stage"],
    dueDate: new Date("2026-03-08T09:00:00.000Z"),
    scheduledStart: new Date("2026-03-05T14:00:00.000Z"),
    scheduledEnd: new Date("2026-03-05T15:00:00.000Z"),
    reminders: [{ offsetMinutes: 30 }],
    assignee: "asc",
    runInTarget: "localProject",
    created: new Date("2026-03-04T09:30:00.000Z"),
    order: 0,
  };
}

export function resolvePageStageStoryPreset(id: string): PageStageStoryPreset {
  return (
    PAGE_STAGE_STORY_PRESETS.find((preset) => preset.id === id) ?? PAGE_STAGE_STORY_DEFAULT_PRESET
  );
}
