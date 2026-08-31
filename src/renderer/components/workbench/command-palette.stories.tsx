import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import type {
  CommandMenuMode,
  CommandPalettePage,
  CommandPaletteCommand,
  CommandPaletteThread,
} from "@/lib/command-palette";
import type { CommandPalettePageSearchBatch } from "@/lib/command-palette-page-results";
import { createCommandPaletteThreadSearchIndex } from "@/lib/command-palette-thread-search";
import type { CommandPaletteThreadSearchBatch } from "@/lib/command-palette-chat-search";
import { buildCommandPaletteCommands } from "@/lib/command-palette-commands";
import type { DatabasePageSummary } from "@/lib/types";
import { plainTextToPortableRichText } from "../../../shared/block-documents";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";
import { CommandPaletteSurface } from "./command-palette-surface";

function makeStoryPage(overrides: Partial<DatabasePageSummary> = {}): DatabasePageSummary {
  const title = overrides.title ?? "Command palette shell refresh";
  return {
    id: overrides.id ?? "palette-page",
    pageKey: overrides.pageKey === undefined ? "LAB-13" : overrides.pageKey,
    status: overrides.status ?? "build",
    title,
    richTitle: overrides.richTitle ?? plainTextToPortableRichText(title),
    tags: overrides.tags ?? ["palette", "shell"],
    archived: false,
    created: new Date("2026-06-20T00:00:00.000Z"),
    order: 0,
    revision: 1,
    descriptionPreview:
      overrides.descriptionPreview ??
      "Replace legacy stage commands with session panel tab actions.",
    descriptionLength: overrides.descriptionLength ?? 84,
    hasDescription: true,
    priority: overrides.priority,
    assignee: overrides.assignee,
    ...overrides,
  };
}

function makePalettePage(
  overrides: Partial<Omit<CommandPalettePage, "page">> & {
    page?: Partial<DatabasePageSummary>;
  } = {},
): CommandPalettePage {
  const page = makeStoryPage(overrides.page ?? {});
  const projectId = overrides.projectId ?? "nodex";
  return {
    kind: "page",
    id: overrides.id ?? page.id,
    projectId,
    projectName: overrides.projectName ?? "Nodex",
    projectAppearance: overrides.projectAppearance ?? DEFAULT_PROJECT_APPEARANCE,
    columnName: overrides.columnName ?? "Build",
    page,
    tagLabels: overrides.tagLabels ?? page.tags,
    inActiveProject: overrides.inActiveProject ?? true,
    recentIndex: overrides.recentIndex ?? null,
    boardIndex: overrides.boardIndex ?? 0,
    searchPreview: overrides.searchPreview ?? null,
    searchDecorations: overrides.searchDecorations ?? null,
  };
}

function makePaletteThread(overrides: Partial<CommandPaletteThread> = {}): CommandPaletteThread {
  return {
    kind: "thread",
    id: overrides.id ?? "thread:thr-palette-search",
    threadId: overrides.threadId ?? "thr-palette-search",
    sessionId: overrides.sessionId === undefined ? "session-palette-search" : overrides.sessionId,
    projectId: overrides.projectId === undefined ? "nodex" : overrides.projectId,
    projectName: overrides.projectName === undefined ? "Nodex" : overrides.projectName,
    title: overrides.title ?? "Command palette thread search",
    preview:
      overrides.preview ?? "Investigate fuzzy thread search and content snippets in the launcher.",
    cwd: overrides.cwd ?? "/Users/asc/nodex",
    gitBranch: overrides.gitBranch ?? null,
    projectless: overrides.projectless ?? false,
    pinned: overrides.pinned ?? false,
    pinnedOrder: overrides.pinnedOrder ?? null,
    statusType: overrides.statusType ?? "notLoaded",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    createdAt: overrides.createdAt ?? 1_781_990_400,
    updatedAt: overrides.updatedAt ?? 1_781_990_400,
    inActiveProject: overrides.inActiveProject ?? true,
    searchPreview: overrides.searchPreview,
    searchDecorations: overrides.searchDecorations,
  };
}

function CommandPaletteStory({
  initialQuery,
  mode,
  includeThreads = false,
  pageSearchBatch,
  threadSearchBatch,
}: {
  initialQuery: string;
  mode: CommandMenuMode;
  includeThreads?: boolean;
  pageSearchBatch?: CommandPalettePageSearchBatch;
  threadSearchBatch?: CommandPaletteThreadSearchBatch;
}) {
  const [open, setOpen] = useState(true);
  const pages = useMemo<CommandPalettePage[]>(
    () => [
      makePalettePage(),
      makePalettePage({
        id: "side-panel-db-view",
        projectId: "codex",
        projectName: "Codex app",
        columnName: "Review",
        boardIndex: 1,
        page: {
          id: "side-panel-db-view",
          title: "DB View command opens as a panel tab",
          tags: ["db", "tabs"],
          status: "review",
          priority: "p1-high",
          descriptionPreview:
            "Keep project database work in the current session shell instead of a global view switch.",
        },
      }),
    ],
    [],
  );
  const commands = useMemo<CommandPaletteCommand[]>(
    () => [
      ...buildCommandPaletteCommands({
        canGoBack: false,
        canGoForward: true,
        canStartNewChat: true,
        canStartNewChatInProject: true,
        pageCreateUnavailableReason: null,
        hasActiveSession: true,
        activeSessionPinned: true,
        hasAttachedThread: false,
        canExportConversationMarkdown: false,
        panelActionAvailability: {
          db_view: true,
          page_stage: true,
          canvas_stage: true,
          terminal: true,
          browser: true,
          review: true,
          files: true,
          side_chat: false,
        },
        canOpenSessionInNewWindow: false,
        isMac: true,
        showMockCommands: true,
      }),
      {
        kind: "command",
        id: "storybook-long-command",
        group: "App",
        title: "Open a very long command title that still needs to truncate cleanly",
        subtitle:
          "Story-only row for scanning title overflow, shortcut alignment, and disabled styling",
        keywords: ["long", "overflow", "disabled"],
        shortcut: "⌘⌥⇧L",
        disabled: true,
        priority: 100,
      },
    ],
    [],
  );
  const threads = useMemo<CommandPaletteThread[]>(
    () =>
      includeThreads
        ? [
            makePaletteThread({ pinned: true, pinnedOrder: 0 }),
            makePaletteThread({
              id: "thread:thr-content-snippet",
              threadId: "thr-content-snippet",
              sessionId: "session-content-snippet",
              projectId: "codex",
              projectName: "Codex app",
              title: "Thread transcript search",
              preview: "Review how chat history search returns bounded snippets.",
              cwd: "/Users/asc/codex-app",
              inActiveProject: false,
              searchPreview: {
                source: "content",
                excerpt:
                  "The launcher should surface transcript matches from previous assistant turns without loading every thread.",
                segments: [
                  { text: "The launcher should surface ", highlight: false },
                  { text: "transcript matches", highlight: true },
                  {
                    text: " from previous assistant turns without loading every thread.",
                    highlight: false,
                  },
                ],
              },
            }),
            makePaletteThread({
              id: "thread:thr-projectless",
              threadId: "thr-projectless",
              sessionId: null,
              projectId: null,
              projectName: null,
              projectless: true,
              title: "Projectless packaging notes",
              preview: "A sidebar chat discovered outside any project source root.",
              cwd: "/tmp/codex-scratch",
              inActiveProject: false,
            }),
            makePaletteThread({
              id: "thread:thr-unicode-highlight",
              threadId: "thr-unicode-highlight",
              title: "修复 😀 search highlighting",
              preview: "验证中文、emoji 与 fuzzy command 的连续字符高亮。",
              gitBranch: "修复/unicode-search",
            }),
          ]
        : [],
    [includeThreads],
  );
  const threadSearchIndex = useMemo(
    () => createCommandPaletteThreadSearchIndex(threads),
    [threads],
  );

  return (
    <div className="min-h-screen bg-token-main-surface-primary px-8 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <CommandPaletteSurface
          open={open}
          openTriggerTick={open ? 1 : 0}
          mode={mode}
          initialQuery={initialQuery}
          commands={commands}
          pages={pages}
          threads={threads}
          threadSearchIndex={threadSearchIndex}
          pageSearchBatch={pageSearchBatch}
          threadSearchBatch={threadSearchBatch}
          loading={false}
          pagesLoading={false}
          chatsLoading={false}
          onChangeMode={() => undefined}
          onRequestClose={() => setOpen(false)}
          onExecute={() => setOpen(false)}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Workbench/Command Palette",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const RootCommands: Story = {
  render: () => <CommandPaletteStory mode="root" initialQuery="" />,
};

export const RootMetadataChats: Story = {
  render: () => <CommandPaletteStory mode="root" initialQuery="pa" includeThreads />,
};

export const RootCommandsChatsAndPages: Story = {
  render: () => (
    <CommandPaletteStory
      mode="root"
      initialQuery="palette"
      includeThreads
      pageSearchBatch={{
        query: "palette",
        scopeKey: "codex\nnodex",
        results: [],
        status: "success",
        error: null,
      }}
      threadSearchBatch={{ query: "palette", loading: false, error: null, results: [] }}
    />
  ),
};

export const RootCommandsAndHistory: Story = {
  render: () => (
    <CommandPaletteStory
      mode="root"
      initialQuery="open"
      includeThreads
      threadSearchBatch={{
        query: "open",
        loading: false,
        error: null,
        results: [
          {
            thread: {
              backendBinding: { kind: "codex" },
              threadId: "thr-server-only-open",
              sessionId: null,
              projectId: "nodex",
              projectName: "Nodex",
              title: "Open task from history",
              preview: "This task is not in the current sidebar snapshot.",
              cwd: "/Users/asc/nodex-archive",
              gitBranch: "archive/search",
              projectless: false,
              pinned: false,
              pinnedOrder: null,
              statusType: "notLoaded",
              statusActiveFlags: [],
              createdAt: 1_781_000_000,
              updatedAt: 1_781_990_500,
            },
            snippet: "Open the archived rollout and compare its search behavior.",
          },
        ],
      }}
    />
  ),
};

export const RootHistoryLoading: Story = {
  render: () => (
    <CommandPaletteStory
      mode="root"
      initialQuery="search"
      includeThreads
      threadSearchBatch={{ query: "search", loading: true, error: null, results: [] }}
    />
  ),
};

export const RootHistoryFailureFallback: Story = {
  render: () => (
    <CommandPaletteStory
      mode="root"
      initialQuery="thread"
      includeThreads
      threadSearchBatch={{
        query: "thread",
        loading: false,
        error: "app-server unavailable",
        results: [],
      }}
    />
  ),
};

export const PageSearch: Story = {
  render: () => <CommandPaletteStory mode="pages" initialQuery="palette" />,
};

export const PageSearchPending: Story = {
  render: () => (
    <CommandPaletteStory
      mode="pages"
      initialQuery="vector clocks"
      pageSearchBatch={{
        query: "previous query",
        scopeKey: "codex\nnodex",
        results: [],
        status: "success",
        error: null,
      }}
    />
  ),
};

export const HistoricalPageKeyMatch: Story = {
  render: () => (
    <CommandPaletteStory
      mode="pages"
      initialQuery="old-13"
      pageSearchBatch={{
        query: "old-13",
        scopeKey: "codex\nnodex",
        results: [
          {
            projectId: "nodex",
            pageId: "palette-page",
            pageKey: "LAB-13",
            title: "Command palette shell refresh",
            status: "build",
            priority: null,
            tags: [],
            assignee: null,
            locationLabel: "Nodex / Build",
            titleParts: [],
            excerpt: "Command palette shell refresh",
            excerptParts: [],
            matches: [
              {
                source: "page_key",
                quality: "exact",
                pageKey: "OLD-13",
                isCurrent: false,
                parts: [],
              },
            ],
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
        ],
        status: "success",
        error: null,
      }}
    />
  ),
};

export const ChatSearch: Story = {
  render: () => <CommandPaletteStory mode="chats" initialQuery="thread search" includeThreads />,
};

export const ChatsPinnedAndRecent: Story = {
  render: () => <CommandPaletteStory mode="chats" initialQuery="" includeThreads />,
};

export const UnicodeHighlight: Story = {
  render: () => <CommandPaletteStory mode="chats" initialQuery="😀" includeThreads />,
};

export const ChatContentSnippet: Story = {
  render: () => (
    <CommandPaletteStory mode="chats" initialQuery="transcript matches" includeThreads />
  ),
};

export const FilesMock: Story = {
  render: () => <CommandPaletteStory mode="files" initialQuery="" />,
};
