import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { CodexConversationItem } from "../../../../lib/types";
import { NodexTooltipProvider as TooltipProvider } from "../../../../components/ui/tooltip";
import {
  installAsyncRequestAnimationFrame,
  installElementScrollHeight,
  installMeasuredResizeObserver,
  installWindowApi,
} from "../../../../test/browser-globals";
import { renderWithMaitai as render, settleAsyncRender, textContent } from "../../../../test/dom";
import { TestQueryProvider } from "../../../../test/query";
import { THREAD_SETTINGS_STORAGE_KEY } from "../../../../lib/codex-thread-settings";
import { CodexThreadSettingsProvider } from "../../../../lib/use-codex-thread-settings";
import { buildCodexFileChangeMap } from "../../../../../shared/codex-file-change";
import { applyContentSearchDomMarks } from "../../../content-search/content-search-dom";
import {
  ThreadContextCompactionBlock,
  ThreadAgentActivityGroupBlock,
  ThreadAssistantBodyBlock,
  ThreadGeneratedImageGalleryBlock,
  ThreadImageViewBlock,
  ThreadMcpServerElicitationBlock,
  ThreadPlanCardBlock,
  ThreadStreamErrorBlock,
  ThreadSystemErrorBlock,
  ThreadTurnDiffBlock,
  ThreadWorktreeInitBlock,
  UserMessageBubble,
  buildThreadWorktreeInitActivities,
} from "./local-conversation-block-leaves";
import { ThreadBlockRenderer } from "./local-conversation-block-renderer";
import { HookFeedbackSettingsNavigationProvider } from "../hook-feedback-settings-navigation";
import type {
  ThreadAgentActivityGroupBlockModel,
  ThreadOpenThreadContext,
  ThreadTranscriptBlockModel,
} from "../../thread-stage-types";

const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const originalGetComputedStyle = window.getComputedStyle;

function buildCommandEntry(
  itemId: string,
  actions: unknown[],
  overrides?: Partial<CodexConversationItem>,
): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    entryId: itemId,
    type: "exec",
    kind: "commandExecution",
    status: "completed",
    command: "fd",
    cwd: "/workspace/nodex",
    commandActions: actions as CodexConversationItem["commandActions"],
    aggregatedOutput: "",
    exitCode: 0,
    toolCall: {
      toolName: "exec",
      subtype: "command",
      args: {
        cwd: "/workspace/nodex",
        commandActions: actions,
      },
      result: "",
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildCommandBlock(
  itemId: string,
  actions: unknown[],
  overrides?: Partial<CodexConversationItem>,
): ThreadTranscriptBlockModel & { type: "exec" } {
  const entry = buildCommandEntry(itemId, actions, overrides);
  return {
    id: entry.entryId ?? entry.itemId,
    turnId: entry.turnId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    searchableText: entry.markdownText ?? entry.command ?? "",
    type: "exec",
    entry,
    status: entry.status,
  };
}

function buildAgentActivityGroupBlock(
  overrides: Partial<ThreadAgentActivityGroupBlockModel> = {},
): ThreadAgentActivityGroupBlockModel {
  const entries = overrides.entries ?? [];
  const bodyEntries = overrides.bodyEntries ?? entries;

  return {
    id: "activity-1",
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 2,
    searchableText: "activity",
    type: "agentActivityGroup",
    canExpand: overrides.canExpand ?? bodyEntries.length > 0,
    entries,
    bodyEntries,
    completedHeader: overrides.completedHeader ?? {
      parts: [],
      iconItem: entries[0] ?? null,
    },
    header: overrides.header ?? { kind: "summary", key: "summary" },
    shouldAnimateInitialCollapse: overrides.shouldAnimateInitialCollapse ?? false,
    status: overrides.status ?? "completed",
    ...overrides,
  };
}

function buildFileChangeEntry(itemId: string): CodexConversationItem {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    entryId: itemId,
    type: "file_change",
    kind: "fileChange",
    semanticKind: "patch",
    status: "completed",
    fileChange: {
      label: undefined,
      changes: buildCodexFileChangeMap([
        {
          path: "src/edited.ts",
          type: "update",
          movePath: null,
          unifiedDiff: ["@@ -1,1 +1,1 @@", "-old value", "+new value"].join("\n"),
        },
      ]),
    },
    toolCall: {
      subtype: "fileChange",
      toolName: "file_change",
      args: {},
      result: null,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildSubagentActivityInlineGroupBlock(): ThreadTranscriptBlockModel {
  const entry: CodexConversationItem = {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "subagent-activity-1",
    entryId: "subagent-activity-1",
    type: "subAgentActivity",
    kind: "systemEvent",
    semanticKind: "systemEvent",
    status: "completed",
    rawItem: {
      id: "subagent-activity-1",
      type: "subAgentActivity",
      kind: "interacted",
      agentThreadId: "thread-child-1",
      agentPath: "@Scout",
    },
    createdAt: 1,
    updatedAt: 1,
  };

  return {
    id: "subagent-activity-inline-group-1",
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 1,
    searchableText: "Scout\nReviewer\nBuilder\nTester\nupdated",
    type: "subagentActivityInlineGroup",
    entry,
    subagentActivityStatusLabel: "updated",
    subagentActivityRows: [
      {
        conversationId: "thread-child-1",
        displayName: "Scout",
        agentRole: null,
        spawnModel: null,
        status: "active",
        activityStatus: "updated",
        statusSummary: "Scout updated",
        diffStats: null,
      },
      {
        conversationId: "thread-child-2",
        displayName: "Reviewer",
        agentRole: null,
        spawnModel: null,
        status: "active",
        activityStatus: "started",
        statusSummary: "Reviewer started working",
        diffStats: null,
      },
      {
        conversationId: "thread-child-3",
        displayName: "Builder",
        agentRole: null,
        spawnModel: null,
        status: "done",
        activityStatus: "done",
        statusSummary: "Builder finished",
        diffStats: null,
      },
      {
        conversationId: "thread-child-4",
        displayName: "Tester",
        agentRole: null,
        spawnModel: null,
        status: "done",
        activityStatus: "interrupted",
        statusSummary: "Tester interrupted",
        diffStats: null,
      },
    ],
  };
}

function buildUserMessageBlock(text: string): ThreadTranscriptBlockModel {
  return {
    id: "user-message-1",
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 1,
    searchableText: text,
    type: "userMessage",
    entry: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-message-1",
      type: "user_message",
      kind: "userMessage",
      semanticKind: "userMessage",
      role: "user",
      markdownText: text,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

function buildAssistantMessageBlock({
  text,
  status,
}: {
  text: string;
  status: CodexConversationItem["status"];
}): ThreadTranscriptBlockModel {
  return {
    id: "assistant-message-1",
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 1,
    searchableText: text,
    type: "assistantMessage",
    entry: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "assistant-message-1",
      entryId: "assistant-message-1",
      type: "assistant_message",
      kind: "assistantMessage",
      semanticKind: "assistantMessage",
      status,
      markdownText: text,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

function installTextCollapseMeasurement({
  scrollHeight,
  lineHeightPx,
}: {
  scrollHeight: number;
  lineHeightPx: number;
}): void {
  installAsyncRequestAnimationFrame();
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return scrollHeight;
    },
  });
  window.getComputedStyle = (() =>
    ({
      lineHeight: `${lineHeightPx}px`,
      fontSize: "16px",
    }) as CSSStyleDeclaration) as typeof window.getComputedStyle;
}

async function settleTextCollapseMeasurement(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function restoreTextCollapseMeasurement(): void {
  if (scrollHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
  } else {
    Reflect.deleteProperty(
      HTMLElement.prototype as HTMLElement & { scrollHeight?: number },
      "scrollHeight",
    );
  }
  window.getComputedStyle = originalGetComputedStyle;
}

function renderUserMessageBubble(text: string) {
  return render(
    <TooltipProvider>
      <UserMessageBubble
        block={buildUserMessageBlock(text)}
        isLatestTurn={false}
        isStreamingTurn={false}
      />
    </TooltipProvider>,
  );
}

function getUserMarkdownRoot(container: ParentNode): HTMLElement {
  const element = container.querySelector<HTMLElement>(".codex-markdown-user");
  if (!element) throw new Error("Expected user markdown root to render.");
  return element;
}

function getUserCollapseRoot(container: ParentNode): HTMLElement {
  const element = getUserMarkdownRoot(container).parentElement;
  if (!element) throw new Error("Expected user message collapse root to render.");
  return element;
}

describe("UserMessageBubble collapse", () => {
  afterEach(() => {
    restoreTextCollapseMeasurement();
  });

  test("does not render a toggle for short user messages", async () => {
    installTextCollapseMeasurement({ scrollHeight: 100, lineHeightPx: 20 });

    const { queryByText } = renderUserMessageBubble("Short request");
    await settleAsyncRender();
    await settleTextCollapseMeasurement();

    expect(queryByText("Show more") === null).toBe(true);
    expect(queryByText("Show less") === null).toBe(true);
  });

  test("labels hook feedback without exposing ordinary edit controls", () => {
    const block = buildUserMessageBlock("Please address the failed check.");
    block.entry.hookFeedback = true;
    block.userMessageActions = { canEdit: false, sentAtMs: null };
    const { getByText, queryByLabelText } = render(
      <TooltipProvider>
        <UserMessageBubble block={block} isLatestTurn isStreamingTurn={false} />
      </TooltipProvider>,
    );

    const status = getByText("Hook feedback");
    expect(status.closest("a")?.getAttribute("href")).toBe(
      "/settings/hooks-settings?hostId=default",
    );
    expect(queryByLabelText("Edit message")).toBe(null);
  });

  test("keeps compact hook feedback actions beside the bubble without duplicating copy", () => {
    const block = buildUserMessageBlock("Please address the failed check.");
    block.entry.hookFeedback = true;
    block.userMessageActions = { canEdit: false, sentAtMs: null };
    const { getAllByLabelText, getByText } = render(
      <TooltipProvider>
        <UserMessageBubble
          block={block}
          isLatestTurn
          isStreamingTurn={false}
          compactUserMessageActions
        />
      </TooltipProvider>,
    );

    const bubble = getByText("Please address the failed check.").closest<HTMLElement>(
      '[data-user-message-bubble="true"]',
    );
    expect(getAllByLabelText("Copy message")).toHaveLength(1);
    expect(
      bubble?.parentElement?.querySelector('button[aria-label="Copy message"]'),
    ).not.toBeNull();
    expect(getByText("Hook feedback")).toBeTruthy();
  });

  test("links matching project hook feedback to its filtered settings source", () => {
    const block = buildUserMessageBlock("Please address the failed check.");
    block.entry.hookFeedback = true;
    block.hookFeedbackSources = ["project"];
    block.userMessageActions = { canEdit: false, sentAtMs: null };
    const onOpenHooksSettings = vi.fn();
    const { getByText } = render(
      <TooltipProvider>
        <HookFeedbackSettingsNavigationProvider
          hostId="remote-1"
          onOpenHooksSettings={onOpenHooksSettings}
        >
          <UserMessageBubble
            block={block}
            isLatestTurn
            isStreamingTurn={false}
            threadCwd="/workspace/nodex"
          />
        </HookFeedbackSettingsNavigationProvider>
      </TooltipProvider>,
    );

    const link = getByText("Hook feedback").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/settings/hooks-settings?hostId=remote-1&source=project&projectRoot=%2Fworkspace%2Fnodex",
    );
    fireEvent.click(link as HTMLElement);
    expect(onOpenHooksSettings).toHaveBeenCalledWith({
      hostId: "remote-1",
      selection: { source: "project", projectRoot: "/workspace/nodex" },
    });
  });

  test("collapses long measured user messages and toggles expansion", async () => {
    installTextCollapseMeasurement({ scrollHeight: 600, lineHeightPx: 20 });
    const longMessage = Array.from({ length: 25 }, (_value, index) => `Line ${index + 1}`).join(
      "\n",
    );

    const { container, getByText } = renderUserMessageBubble(longMessage);
    await settleAsyncRender();
    await settleTextCollapseMeasurement();

    const collapsedButton = getByText("Show more").closest("button");
    expect(collapsedButton?.getAttribute("aria-expanded")).toBe("false");

    const collapsedStyle = getUserCollapseRoot(container).getAttribute("style") ?? "";
    expect(collapsedStyle.includes("overflow: hidden")).toBe(true);
    expect(collapsedStyle.includes("max-height: 400px")).toBe(true);

    fireEvent.click(collapsedButton as HTMLElement);
    await settleAsyncRender();

    const expandedButton = getByText("Show less").closest("button");
    expect(expandedButton?.getAttribute("aria-expanded")).toBe("true");
    expect(getUserCollapseRoot(container).getAttribute("style") ?? "").toBe("");
    expect(Boolean(expandedButton?.querySelector(".rotate-180"))).toBe(true);

    fireEvent.click(expandedButton as HTMLElement);
    await settleAsyncRender();

    expect(getByText("Show more").closest("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(getUserCollapseRoot(container).getAttribute("style") ?? "").toContain(
      "max-height: 400px",
    );
  });

  test("does not render a toggle when content fits the exact collapsed height", async () => {
    installTextCollapseMeasurement({ scrollHeight: 400, lineHeightPx: 20 });
    const longMessage = Array.from({ length: 25 }, (_value, index) => `Line ${index + 1}`).join(
      "\n",
    );
    const view = renderUserMessageBubble(longMessage);
    await settleAsyncRender();
    await settleTextCollapseMeasurement();

    expect(view.queryByText("Show more") === null).toBe(true);
  });

  test("collapses again when expanded text changes", async () => {
    installTextCollapseMeasurement({ scrollHeight: 600, lineHeightPx: 20 });
    const firstMessage = Array.from({ length: 25 }, (_value, index) => `First ${index + 1}`).join(
      "\n",
    );
    const secondMessage = Array.from({ length: 25 }, (_value, index) => `Second ${index + 1}`).join(
      "\n",
    );

    const view = renderUserMessageBubble(firstMessage);
    await settleAsyncRender();
    await settleTextCollapseMeasurement();

    fireEvent.click(view.getByText("Show more").closest("button") as HTMLElement);
    await settleAsyncRender();
    expect(view.getByText("Show less").closest("button")?.getAttribute("aria-expanded")).toBe(
      "true",
    );

    view.rerender(
      <TooltipProvider>
        <UserMessageBubble
          block={buildUserMessageBlock(secondMessage)}
          isLatestTurn={false}
          isStreamingTurn={false}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();
    await settleTextCollapseMeasurement();

    expect(view.getByText("Show more").closest("button")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
});

describe("ThreadAssistantBodyBlock streaming markdown", () => {
  test("keeps a completed latest assistant item static while the turn is still active", async () => {
    const { container } = render(
      <ThreadAssistantBodyBlock
        block={buildAssistantMessageBlock({
          text: "Completed assistant prose should not reanimate while another turn item is still active.",
          status: "completed",
        })}
        isLatestTurn={true}
        isStreamingTurn={true}
      />,
    );

    await settleAsyncRender();

    expect(container.querySelector("[data-sd-animate]") === null).toBe(true);
  });

  test("keeps animation enabled for the in-progress assistant item", async () => {
    const { container } = render(
      <ThreadAssistantBodyBlock
        block={buildAssistantMessageBlock({
          text: "Streaming assistant prose should still use Streamdown word fade while the item is in progress.",
          status: "inProgress",
        })}
        isLatestTurn={true}
        isStreamingTurn={true}
      />,
    );

    await settleAsyncRender();

    expect(container.querySelectorAll("[data-sd-animate]").length > 0).toBe(true);
  });
});

describe("ThreadAgentActivityGroupBlock", () => {
  beforeEach(() => {
    installElementScrollHeight(120);
    installMeasuredResizeObserver({ blockSize: 120, inlineSize: 320 });
  });

  test("starts collapsed and expands a Codex-style body with original flat entries", async () => {
    const readBlock = buildCommandBlock("item-1", [
      { type: "read", command: "cat a.ts", name: "./src/a.ts", path: "./src/a.ts" },
    ]);
    const block = buildAgentActivityGroupBlock({
      id: "activity-1",
      entries: [readBlock],
      completedHeader: {
        parts: [{ kind: "exploration" }],
        iconItem: readBlock,
      },
    });

    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={false} isStreamingTurn={false} />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Read files/i });
    expect(summaryButton.getAttribute("aria-expanded") ?? "").toBe("false");
    const collapsedBody = container.querySelector<HTMLElement>(
      "[data-testid='agent-activity-group-body']",
    );
    expect(collapsedBody?.getAttribute("aria-hidden")).toBe("true");
    expect(collapsedBody?.hasAttribute("inert")).toBe(true);

    await act(async () => {
      fireEvent.click(summaryButton);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(summaryButton.getAttribute("aria-expanded") ?? "").toBe("true");
    expect(collapsedBody?.getAttribute("aria-hidden")).toBe("false");
    expect(Boolean(textContent(container).includes("Read src/a.ts"))).toBe(true);
    expect(
      applyContentSearchDomMarks({
        root: container,
        query: "src/a.ts",
        idPrefix: "expanded-activity",
      }).totalMatches > 0,
    ).toBe(true);
    expect(Boolean(textContent(container).includes("Exploration"))).toBe(false);
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(false);
    const scroller = [
      ...container.querySelectorAll<HTMLElement>(".vertical-scroll-fade-mask"),
    ].find((element) => element.style.getPropertyValue("--conversation-patch-file-gap") !== "");
    const groupedSpacer = scroller?.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(scroller?.style.getPropertyValue("--conversation-patch-file-gap") ?? "").toBe(
      "var(--conversation-grouped-item-gap, 4px)",
    );
    expect(groupedSpacer?.getAttribute("aria-hidden") ?? "").toBe("true");
  });

  test("shimmers only the latest streaming active summary", () => {
    const commandBlock = buildCommandBlock("item-command-active", [], {
      status: "inProgress",
      command: "bun test",
      exitCode: undefined,
    });
    const block = buildAgentActivityGroupBlock({
      id: "activity-active",
      searchableText: "activity active",
      status: "inProgress",
      header: {
        kind: "active",
        key: "item-command-active",
        label: "Running bun test",
        item: commandBlock,
      },
      completedHeader: {
        parts: [{ kind: "commands", count: 1 }],
        iconItem: commandBlock,
      },
      entries: [commandBlock],
    });

    const { getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={true} isStreamingTurn={true} />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Running bun test/i });
    const shimmer = summaryButton.querySelector<HTMLElement>(".loading-shimmer-pure-text");
    expect(shimmer?.firstChild?.textContent ?? "").toBe("Running bun test");
    expect(Boolean(textContent(summaryButton).includes("Ran 1 command"))).toBe(false);
  });

  test("renders the latest open group's Thinking fallback as its only live header", () => {
    const commandBlock = buildCommandBlock("item-command-completed", [], {
      status: "completed",
      command: "pnpm test",
      exitCode: 0,
    });
    const block = buildAgentActivityGroupBlock({
      id: "activity-thinking-owner",
      searchableText: "completed command",
      header: {
        kind: "thinking",
        key: "thinking",
        message: null,
      },
      completedHeader: {
        parts: [{ kind: "commands", count: 1 }],
        iconItem: commandBlock,
      },
      entries: [commandBlock],
    });

    const { getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={true} isStreamingTurn={true} />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Thinking/i });
    expect(Boolean(textContent(summaryButton).includes("Ran a command"))).toBe(false);
    expect(summaryButton.querySelectorAll(".loading-shimmer-pure-text").length).toBe(1);
    expect(summaryButton.querySelectorAll("[data-tool-activity-icon]").length).toBe(0);
  });

  test("does not shimmer a latest streaming completed fallback summary", () => {
    const webEntry: CodexConversationItem = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "web-completed",
      entryId: "web-completed",
      type: "web_search",
      kind: "toolCall",
      semanticKind: "webSearch",
      status: "completed",
      toolCall: {
        subtype: "webSearch",
        toolName: "web_search",
        args: { query: "completed query" },
        result: { type: "search", query: "completed query" },
      },
      rawItem: { action: { type: "search", query: "completed query" } },
      createdAt: 1,
      updatedAt: 2,
    };
    const webBlock = {
      id: "web-completed",
      turnId: "turn-1",
      createdAt: 1,
      updatedAt: 2,
      searchableText: "completed query",
      type: "webSearch" as const,
      entry: webEntry,
      status: "completed" as const,
    };
    const block = buildAgentActivityGroupBlock({
      id: "activity-web-completed",
      searchableText: "completed query",
      completedHeader: {
        parts: [{ kind: "webSearch" }],
        iconItem: webBlock,
      },
      entries: [webBlock],
    });

    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={true} isStreamingTurn={true} />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Searched the web/i });
    expect(Boolean(textContent(summaryButton).includes("Searching the web"))).toBe(false);
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(false);
  });

  test("defers live active summary changes through the shared activity disclosure", async () => {
    const originalDateNow = Date.now;
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    let now = 0;
    let nextTimerId = 1;
    const scheduledTimers = new Map<number, { callback: () => void; delay: number }>();
    Date.now = () => now;
    window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      const timerId = nextTimerId++;
      if (typeof callback === "function") {
        scheduledTimers.set(timerId, { callback: () => callback(), delay: delay ?? 0 });
      }
      return timerId;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timerId?: number) => {
      if (timerId !== undefined) scheduledTimers.delete(timerId);
    }) as typeof window.clearTimeout;

    const buildBlock = (key: string, label: string) => {
      const commandBlock = buildCommandBlock(key, [], {
        status: "inProgress",
        command: label.replace(/^Running /, ""),
        exitCode: undefined,
      });
      return buildAgentActivityGroupBlock({
        id: "activity-deferred-summary",
        searchableText: label,
        status: "inProgress",
        entries: [commandBlock],
        completedHeader: {
          parts: [{ kind: "commands", count: 1 }],
          iconItem: commandBlock,
        },
        header: {
          kind: "active",
          key,
          item: commandBlock,
          label,
        },
      });
    };

    try {
      const view = render(
        <TooltipProvider>
          <ThreadAgentActivityGroupBlock
            block={buildBlock("first", "Running first command")}
            isLatestTurn={true}
            isStreamingTurn={true}
          />
        </TooltipProvider>,
      );

      expect(Boolean(textContent(view.container).includes("Running first command"))).toBe(true);

      now = 100;
      await act(async () => {
        view.rerender(
          <TooltipProvider>
            <ThreadAgentActivityGroupBlock
              block={buildBlock("second", "Running second command")}
              isLatestTurn={true}
              isStreamingTurn={true}
            />
          </TooltipProvider>,
        );
        await Promise.resolve();
      });

      expect(textContent(view.container).includes("Running first command")).toBe(true);
      expect(textContent(view.container).includes("Running second command")).toBe(false);
      const summaryTimer =
        Array.from(scheduledTimers.values()).find((timer) => timer.delay === 900) ?? null;
      expect(Boolean(summaryTimer)).toBe(true);

      now = 1000;
      await act(async () => {
        summaryTimer?.callback();
        await Promise.resolve();
      });

      expect(textContent(view.container).includes("Running second command")).toBe(true);
    } finally {
      Date.now = originalDateNow;
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  });

  test("renders a live file-change header from the exact active item", async () => {
    const liveFileChangeEntry = buildFileChangeEntry("item-file-live");
    const content = Array.from({ length: 85 }, (_, index) => `line ${index + 1}`).join("\n");
    liveFileChangeEntry.status = "inProgress";
    liveFileChangeEntry.fileChange = {
      label: undefined,
      changes: buildCodexFileChangeMap([{ type: "add", path: "poem.md", content }]),
    };

    const fileChangeBlock = {
      id: liveFileChangeEntry.entryId ?? liveFileChangeEntry.itemId,
      turnId: liveFileChangeEntry.turnId,
      createdAt: liveFileChangeEntry.createdAt,
      updatedAt: liveFileChangeEntry.updatedAt,
      searchableText: "file change",
      type: "fileChange" as const,
      entry: liveFileChangeEntry,
      status: liveFileChangeEntry.status,
    };
    const block = buildAgentActivityGroupBlock({
      id: "activity-file-live",
      searchableText: "activity file live",
      status: "inProgress",
      header: {
        kind: "active",
        key: "item-file-live",
        item: fileChangeBlock,
        label: "Editing files",
      },
      completedHeader: {
        parts: [{ kind: "fileChanges", count: 1 }],
        iconItem: fileChangeBlock,
      },
      entries: [fileChangeBlock],
    });

    const { container } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={true} isStreamingTurn={true} />
      </TooltipProvider>,
    );

    const summaryButton = container.querySelector<HTMLButtonElement>(
      "button[aria-expanded='false']",
    );
    if (!summaryButton) throw new Error("Expected collapsed activity summary button");
    expect(Boolean(textContent(summaryButton).includes("Editing files"))).toBe(true);
    const shimmer = summaryButton.querySelector<HTMLElement>(".loading-shimmer-pure-text");
    expect(Boolean(shimmer)).toBe(true);
    expect(shimmer?.firstChild?.textContent ?? "").toBe("Editing files");
    expect(Boolean(summaryButton.querySelector(".diff-stat-digit-stack-8"))).toBe(false);

    fireEvent.click(summaryButton);
    await settleAsyncRender();

    expect(Boolean(container.querySelector('[data-testid="agent-activity-group-body"]'))).toBe(
      true,
    );
    expect(Boolean(textContent(container).includes("Creating"))).toBe(true);
    expect(Boolean(textContent(container).includes("poem.md"))).toBe(true);
    expect(Boolean(textContent(container).includes("Exploration"))).toBe(false);
  });

  test("keeps completed collapsed summaries static", () => {
    const explorationBlock = buildCommandBlock("item-explore-static", [
      { type: "read", command: "cat src/a.ts", name: "src/a.ts", path: "src/a.ts" },
    ]);
    const commandBlock = buildCommandBlock("item-command-static", [], { command: "pnpm test" });
    const block = buildAgentActivityGroupBlock({
      id: "activity-static",
      searchableText: "activity static",
      completedHeader: {
        parts: [{ kind: "exploration" }, { kind: "commands", count: 1 }],
        iconItem: explorationBlock,
      },
      entries: [explorationBlock, commandBlock],
    });

    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={true} isStreamingTurn={false} />
      </TooltipProvider>,
    );

    getByRole("button", { name: /Read files, ran a command/i });
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(false);
  });

  test("never shimmers a completed aggregate summary", () => {
    const fileChangeEntry = buildFileChangeEntry("item-file-aggregate");
    const fileChangeBlock = {
      id: fileChangeEntry.entryId ?? fileChangeEntry.itemId,
      turnId: fileChangeEntry.turnId,
      createdAt: fileChangeEntry.createdAt,
      updatedAt: fileChangeEntry.updatedAt,
      searchableText: "file change",
      type: "fileChange" as const,
      entry: fileChangeEntry,
      status: fileChangeEntry.status,
    };
    const block = buildAgentActivityGroupBlock({
      id: "activity-aggregate",
      searchableText: "activity aggregate",
      completedHeader: {
        parts: [{ kind: "fileChanges", count: 1 }],
        iconItem: fileChangeBlock,
      },
      entries: [fileChangeBlock],
    });

    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={true} isStreamingTurn={true} />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Edited a file/i });
    expect(Boolean(summaryButton.querySelector(".loading-shimmer-pure-text"))).toBe(false);
    const initiallyMountedBody = container.querySelector<HTMLElement>(
      "[data-testid='agent-activity-group-body']",
    );
    expect(initiallyMountedBody?.getAttribute("aria-hidden")).toBe("true");
    expect(initiallyMountedBody?.hasAttribute("inert")).toBe(true);
  });

  test("renders a completed single-file change as an aggregate activity header before the row", async () => {
    const fileChangeEntry = buildFileChangeEntry("item-file-single");
    const fileChangeBlock = {
      id: fileChangeEntry.entryId ?? fileChangeEntry.itemId,
      turnId: fileChangeEntry.turnId,
      createdAt: fileChangeEntry.createdAt,
      updatedAt: fileChangeEntry.updatedAt,
      searchableText: "file change",
      type: "fileChange" as const,
      entry: fileChangeEntry,
      status: fileChangeEntry.status,
    };
    const block = buildAgentActivityGroupBlock({
      id: "activity-single-file",
      searchableText: "single file activity",
      completedHeader: {
        parts: [{ kind: "fileChanges", count: 1 }],
        iconItem: fileChangeBlock,
      },
      entries: [fileChangeBlock],
    });

    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={false} isStreamingTurn={false} />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Edited a file/i });
    expect(Boolean(textContent(summaryButton).includes("2 lines"))).toBe(false);
    const collapsedBody = container.querySelector<HTMLElement>(
      "[data-testid='agent-activity-group-body']",
    );
    expect(collapsedBody?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(summaryButton);
    await waitFor(() => {
      if (!textContent(container).includes("edited.ts")) {
        throw new Error("Expected expanded file-change row to render.");
      }
    });

    const content = textContent(container);
    expect(collapsedBody?.getAttribute("aria-hidden")).toBe("false");
    expect(Boolean(content.includes("Edited"))).toBe(true);
    expect(Boolean(content.includes("edited.ts"))).toBe(true);
    expect(Boolean(content.includes("+1"))).toBe(true);
    expect(Boolean(content.includes("-1"))).toBe(true);
  });

  test("keeps family-specific leading icons on expanded tool rows", async () => {
    const commandEntry = buildCommandEntry("item-command", [], {
      command: "bun test",
      commandActions: [],
    });
    const fileChangeEntry = buildFileChangeEntry("item-file-change");
    const readBlock = buildCommandBlock("item-read", [
      { type: "read", command: "cat src/a.ts", name: "src/a.ts", path: "src/a.ts" },
    ]);
    const searchBlock = buildCommandBlock("item-search", [
      { type: "search", command: "rg thing", query: "thing", path: "src" },
    ]);
    const listBlock = buildCommandBlock("item-list", [
      { type: "listFiles", command: "fd", path: "src" },
    ]);
    const commandBlock = {
      id: commandEntry.entryId ?? commandEntry.itemId,
      turnId: commandEntry.turnId,
      createdAt: commandEntry.createdAt,
      updatedAt: commandEntry.updatedAt,
      searchableText: "command",
      type: "exec" as const,
      entry: commandEntry,
      status: commandEntry.status,
    };
    const fileChangeBlock = {
      id: fileChangeEntry.entryId ?? fileChangeEntry.itemId,
      turnId: fileChangeEntry.turnId,
      createdAt: fileChangeEntry.createdAt,
      updatedAt: fileChangeEntry.updatedAt,
      searchableText: "file change",
      type: "fileChange" as const,
      entry: fileChangeEntry,
      status: fileChangeEntry.status,
    };
    const block = buildAgentActivityGroupBlock({
      id: "activity-icons",
      searchableText: "activity icons",
      completedHeader: {
        parts: [
          { kind: "fileChanges", count: 1 },
          { kind: "exploration" },
          { kind: "commands", count: 1 },
        ],
        iconItem: fileChangeBlock,
      },
      entries: [readBlock, searchBlock, listBlock, commandBlock, fileChangeBlock],
    });

    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadAgentActivityGroupBlock block={block} isLatestTurn={false} isStreamingTurn={false} />
      </TooltipProvider>,
    );

    const summaryButton = getByRole("button", { name: /Edited a file/i });
    expect(summaryButton.querySelectorAll("[data-tool-activity-icon='edit-files']").length).toBe(1);
    expect(summaryButton.querySelectorAll("[data-tool-activity-icon='run-command']").length).toBe(
      0,
    );

    fireEvent.click(summaryButton);
    await settleAsyncRender();

    const content = textContent(container);
    expect(content.includes("Read src/a.ts")).toBe(true);
    expect(content.includes("Searched for thing in src")).toBe(true);
    expect(content.includes("Listed files in src")).toBe(true);
    expect(content.includes("Ran bun test")).toBe(true);
    expect(content.includes("Edited")).toBe(true);
    const groupBody = container.querySelector("[data-testid='agent-activity-group-body']");
    expect(groupBody?.querySelectorAll("[data-tool-activity-icon='read-files']").length).toBe(1);
    expect(groupBody?.querySelectorAll("[data-tool-activity-icon='code-searching']").length).toBe(
      1,
    );
    expect(groupBody?.querySelectorAll("[data-tool-activity-icon='list-files']").length).toBe(1);
    expect(groupBody?.querySelectorAll("[data-tool-activity-icon='run-command']").length).toBe(1);
    expect(groupBody?.querySelectorAll("[data-tool-activity-icon='edit-files']").length).toBe(1);
  });
});

describe("ThreadWorktreeInitBlock", () => {
  const entry: CodexConversationItem = {
    threadId: "thread-1",
    turnId: "turn-worktree-init",
    itemId: "pending-worktree:4",
    entryId: "pending-worktree:4",
    type: "worktreeInit",
    kind: "systemEvent",
    semanticKind: "worktreeInit",
    status: "completed",
    rawItem: {
      id: "pending-worktree:4",
      type: "worktreeInit",
      worktreeOutputText: "[info] Starting worktree creation\n[info] Worktree created\n",
      setup: {
        outcome: "skipped",
        outputText: "[info] Continuing without local environment setup\n",
      },
    },
    createdAt: 1,
    updatedAt: 1,
  };

  test("projects the exact completed worktree and optional setup activities", () => {
    const activities = buildThreadWorktreeInitActivities(entry);

    expect(activities.length).toBe(2);
    expect(activities[0]?.id).toBe("pending-worktree:4:worktree");
    expect(activities[0]?.status).toBe("completed");
    expect(activities[1]?.id).toBe("pending-worktree:4:setup");
    expect(activities[1]?.status).toBe("skipped");
  });

  test("renders completed activities collapsed with shared plain shell output", async () => {
    const { getByRole, getByText } = render(
      <TooltipProvider>
        <ThreadWorktreeInitBlock
          block={{
            id: "pending-worktree:4",
            turnId: "turn-worktree-init",
            createdAt: 1,
            updatedAt: 1,
            searchableText: "Worktree initialization",
            type: "worktreeInit",
            status: "completed",
            entry,
          }}
          isLatestTurn
          isStreamingTurn={false}
        />
      </TooltipProvider>,
    );

    getByText("Worktree created");
    getByText("Environment setup skipped");
    expect(getByRole("button", { name: "Worktree created" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      getByRole("button", { name: "Environment setup skipped" }).getAttribute("aria-expanded"),
    ).toBe("false");

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Environment setup skipped" }));
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });
    getByText("[info] Continuing without local environment setup");
  });
});

describe("ThreadContextCompactionBlock", () => {
  test("renders the completed Codex divider row", () => {
    const { container, getByText } = render(
      <ThreadContextCompactionBlock
        block={{
          id: "compact-1",
          turnId: "turn-1",
          createdAt: 1,
          updatedAt: 1,
          searchableText: "Context automatically compacted",
          type: "contextCompaction",
          status: "completed",
          entry: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "compact-1",
            type: "context_compaction",
            kind: "systemEvent",
            semanticKind: "contextCompaction",
            status: "completed",
            markdownText: "Context automatically compacted",
            createdAt: 1,
            updatedAt: 1,
          },
        }}
        isLatestTurn={false}
        isStreamingTurn={false}
      />,
    );

    getByText("Context automatically compacted");
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(false);
    expect(container.querySelectorAll(".border-current\\/20").length).toBe(2);
    expect(Boolean(container.querySelector("svg"))).toBe(true);
  });

  test("renders the in-progress Codex shimmer row", () => {
    const { container, getByText } = render(
      <ThreadContextCompactionBlock
        block={{
          id: "compact-2",
          turnId: "turn-1",
          createdAt: 1,
          updatedAt: 1,
          searchableText: "Automatically compacting context",
          type: "contextCompaction",
          status: "inProgress",
          entry: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "compact-2",
            type: "context_compaction",
            kind: "systemEvent",
            semanticKind: "contextCompaction",
            status: "inProgress",
            markdownText: "Automatically compacting context",
            createdAt: 1,
            updatedAt: 1,
          },
        }}
        isLatestTurn={true}
        isStreamingTurn={true}
      />,
    );

    getByText("Automatically compacting context", { selector: ".loading-shimmer-pure-text" });
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(true);
    expect(Boolean(container.querySelector("svg"))).toBe(false);
  });
});

describe("ThreadPlanCardBlock", () => {
  test("uses the Codex writing-plan shell without the old proposed-plan eyebrow", () => {
    const { container, getByText } = render(
      <TooltipProvider>
        <ThreadPlanCardBlock
          block={{
            id: "plan-1",
            turnId: "turn-1",
            createdAt: 1,
            updatedAt: 1,
            searchableText: "plan",
            type: "proposedPlan",
            entry: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "plan-1",
              type: "proposedPlan",
              kind: "plan",
              semanticKind: "proposedPlan",
              status: "inProgress",
              markdownText: "# Plan\n\n1. Investigate\n2. Implement",
              createdAt: 1,
              updatedAt: 1,
            },
          }}
          isLatestTurn
          isStreamingTurn
        />
      </TooltipProvider>,
    );

    getByText("Writing plan", { selector: "[data-codex-shimmer]" });
    expect(Boolean(textContent(container).includes("Proposed plan"))).toBe(false);
    expect(Boolean(textContent(container).includes("Expand plan"))).toBe(false);
  });

  test("opens the side panel from a completed proposed-plan item", () => {
    let openedKey = "";
    let openedContent = "";
    const { container } = render(
      <TooltipProvider>
        <ThreadPlanCardBlock
          block={{
            id: "plan-1",
            turnId: "turn-1",
            createdAt: 1,
            updatedAt: 1,
            searchableText: "plan",
            type: "proposedPlan",
            entry: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "plan-1",
              type: "proposedPlan",
              kind: "plan",
              semanticKind: "proposedPlan",
              status: "completed",
              markdownText: "# Plan\n\n1. Investigate\n2. Implement",
              createdAt: 1,
              updatedAt: 1,
            },
          }}
          isLatestTurn
          isStreamingTurn={false}
          threadCwd="/tmp/project"
          planSidePanelState={{
            rightPanelEnabled: true,
            activePlanKey: null,
            activeRightPanelTabId: null,
          }}
          onOpenPlanInSidePanel={(input) => {
            openedKey = input.planKey;
            openedContent = input.content;
          }}
        />
      </TooltipProvider>,
    );

    const overlay = container.querySelector("button[aria-hidden='true'][tabindex='-1']");
    expect(Boolean(overlay)).toBe(true);

    fireEvent.click(overlay as HTMLButtonElement);

    expect(openedKey).toBe("turn-1");
    expect(openedContent).toBe("# Plan\n\n1. Investigate\n2. Implement");
  });

  test("collapses the proposed-plan preview while its side-panel tab is active", () => {
    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadPlanCardBlock
          block={{
            id: "plan-1",
            turnId: "turn-1",
            createdAt: 1,
            updatedAt: 1,
            searchableText: "plan",
            type: "proposedPlan",
            entry: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "plan-1",
              type: "proposedPlan",
              kind: "plan",
              semanticKind: "proposedPlan",
              status: "completed",
              markdownText: "# Plan\n\n1. Investigate\n2. Implement",
              createdAt: 1,
              updatedAt: 1,
            },
          }}
          isLatestTurn
          isStreamingTurn={false}
          planSidePanelState={{
            rightPanelEnabled: true,
            activePlanKey: "turn-1",
            activeRightPanelTabId: "plan",
          }}
          onClosePlanSidePanel={() => undefined}
        />
      </TooltipProvider>,
    );

    const body = container.querySelector("[data-plan-preview-body='true']");
    expect(Boolean(getByRole("button", { name: "Close plan side panel" }))).toBe(true);
    expect(body?.getAttribute("aria-hidden")).toBe("true");
    expect(Boolean(body?.hasAttribute("inert"))).toBe(true);
  });
});

describe("ThreadBlockRenderer proposed-plan block", () => {
  test("forwards side-panel actions into the plan card", () => {
    let openedKey = "";
    const { container, getByRole } = render(
      <TooltipProvider>
        <ThreadBlockRenderer
          block={{
            id: "plan-1",
            turnId: "turn-1",
            createdAt: 1,
            updatedAt: 1,
            searchableText: "plan",
            type: "proposedPlan",
            entry: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "plan-1",
              type: "proposedPlan",
              kind: "plan",
              semanticKind: "proposedPlan",
              status: "completed",
              markdownText: "# Plan\n\nOpen this in a side panel.",
              createdAt: 1,
              updatedAt: 1,
            },
          }}
          isLatestTurn
          isStreamingTurn={false}
          threadCwd="/tmp/project"
          planSidePanelState={{
            rightPanelEnabled: true,
            activePlanKey: null,
            activeRightPanelTabId: null,
          }}
          onOpenPlanInSidePanel={(input) => {
            openedKey = input.planKey;
          }}
        />
      </TooltipProvider>,
    );

    expect(Boolean(getByRole("button", { name: "Open plan in side panel" }))).toBe(true);

    const overlay = container.querySelector("button[aria-hidden='true'][tabindex='-1']");
    expect(Boolean(overlay)).toBe(true);

    fireEvent.click(overlay as HTMLButtonElement);

    expect(openedKey).toBe("turn-1");
  });
});

describe("ThreadBlockRenderer subagent activity block", () => {
  test("renders capped inline chips and opens subagents with inline activity context", () => {
    const opened: Array<{ threadId: string; context?: ThreadOpenThreadContext }> = [];
    const completeBlock = buildSubagentActivityInlineGroupBlock();
    const initialBlock = {
      ...completeBlock,
      subagentActivityRows: completeBlock.subagentActivityRows?.slice(0, 2),
    };
    const view = render(
      <ThreadBlockRenderer
        block={initialBlock}
        isLatestTurn
        isStreamingTurn={false}
        onOpenThread={(threadId, context) => {
          opened.push({ threadId, context });
        }}
      />,
    );
    expect(Boolean(view.container.querySelector("[data-animate-entrance]"))).toBe(false);

    view.rerender(
      <ThreadBlockRenderer
        block={completeBlock}
        isLatestTurn
        isStreamingTurn={false}
        onOpenThread={(threadId, context) => {
          opened.push({ threadId, context });
        }}
      />,
    );

    const group = view.getByTestId("subagent-activity-inline-group");
    const buttons = group.querySelectorAll("button");

    expect(Boolean(group)).toBe(true);
    expect(buttons.length).toBe(3);
    expect(Boolean(view.getByText("and 1 other subagent updated"))).toBe(true);
    expect(Boolean(view.queryByText("Tester"))).toBe(false);
    expect(view.container.querySelectorAll("[data-animate-entrance]").length).toBe(1);
    expect(
      Boolean(view.container.querySelector('[data-subagent-avatar-seed="thread-child-1"]')),
    ).toBe(true);

    expect(group.getAttribute("role")).toBe("status");
    expect(group.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(view.getByRole("button", { name: "Open subagent Scout" }));

    expect(opened.length).toBe(1);
    expect(opened[0]?.threadId).toBe("thread-child-1");
    expect(opened[0]?.context?.subagent?.conversationId).toBe("thread-child-1");
    expect(opened[0]?.context?.subagent?.displayName).toBe("Scout");
    expect(opened[0]?.context?.subagent?.status).toBe("active");
    expect(opened[0]?.context?.subagent?.statusSummary).toBe("Scout updated");
    expect(opened[0]?.context?.subagent?.showInlineActivity ?? false).toBe(true);
    expect(opened[0]?.context?.subagent?.agentRole).toBe(null);
    expect(opened[0]?.context?.subagent?.spawnModel).toBe(null);
    expect(opened[0]?.context?.subagent?.diffStats).toBe(null);
  });
});

describe("ThreadStreamErrorBlock", () => {
  beforeEach(() => {
    installElementScrollHeight(96);
    installMeasuredResizeObserver({ blockSize: 96, inlineSize: 320 });
  });

  test("renders a Codex-style reconnect row inside the thread body and expands details on demand", async () => {
    const { container, getByText } = render(
      <ThreadStreamErrorBlock
        block={{
          id: "error:turn-1",
          turnId: "turn-1",
          createdAt: 1,
          updatedAt: 1,
          searchableText: "Reconnecting... 2/5",
          type: "streamError",
          status: "inProgress",
          entry: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "error:turn-1",
            entryId: "error:turn-1",
            type: "error",
            kind: "systemEvent",
            semanticKind: "streamError",
            status: "inProgress",
            markdownText: "Reconnecting... 2/5",
            additionalDetails: "Network error: connection dropped while streaming.",
            willRetry: true,
            createdAt: 1,
            updatedAt: 1,
          },
        }}
        isLatestTurn
        isStreamingTurn
      />,
    );

    getByText("Reconnecting... 2/5");
    expect(Boolean(container.querySelector(".loading-shimmer-pure-text"))).toBe(false);
    expect(
      Boolean(
        container.textContent?.includes("Network error: connection dropped while streaming."),
      ),
    ).toBe(false);

    fireEvent.click(getByText("Reconnecting... 2/5"));
    await settleAsyncRender();

    expect(
      Boolean(
        container.textContent?.includes("Network error: connection dropped while streaming."),
      ),
    ).toBe(true);
  });
});

describe("ThreadSystemErrorBlock", () => {
  test("renders the Codex-style terminal system error row without generic banner chrome", () => {
    const { container, getByText } = render(
      <ThreadSystemErrorBlock
        block={{
          id: "error:turn-2",
          turnId: "turn-2",
          createdAt: 1,
          updatedAt: 1,
          searchableText: "Failed to reconnect to the stream.",
          type: "systemError",
          status: "failed",
          entry: {
            threadId: "thread-1",
            turnId: "turn-2",
            itemId: "error:turn-2",
            entryId: "error:turn-2",
            type: "error",
            kind: "systemEvent",
            semanticKind: "systemError",
            status: "failed",
            markdownText: "Failed to reconnect to the stream.",
            createdAt: 1,
            updatedAt: 1,
          },
        }}
        isLatestTurn={false}
        isStreamingTurn={false}
      />,
    );

    getByText("Failed to reconnect to the stream.");
    expect(Boolean(container.querySelector(".uppercase"))).toBe(false);
  });
});

describe("image-view and completed elicitation leaves", () => {
  beforeEach(() => {
    installWindowApi({});
    installMeasuredResizeObserver({ blockSize: 72, inlineSize: 320 });
  });

  test("keeps turn-wide inspected images behind a default-collapsed gallery disclosure", async () => {
    const imageOne = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
    const imageTwo =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cpath/%3E%3C/svg%3E";
    const { container } = render(
      <ThreadImageViewBlock
        block={{
          id: "image-view-1",
          turnId: "turn-1",
          createdAt: 1,
          updatedAt: 2,
          searchableText: `${imageOne}\n${imageTwo}`,
          type: "imageView",
          status: "completed",
          imageViewPaths: [imageOne, imageTwo],
          entry: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "image-view-1",
            type: "imageView",
            kind: "systemEvent",
            semanticKind: "imageView",
            status: "completed",
            rawItem: { id: "image-view-1", type: "imageView", path: imageOne },
            createdAt: 1,
            updatedAt: 1,
          },
        }}
        isLatestTurn
        isStreamingTurn={false}
      />,
    );

    expect(container.querySelectorAll('button[aria-label="Inspected image"]').length).toBe(0);
    fireEvent.click(container.querySelector('button[aria-expanded="false"]') as HTMLElement);
    await settleAsyncRender();
    expect(container.querySelectorAll('button[aria-label="Inspected image"]').length).toBe(2);
  });

  test("renders generated images and pending output in the dedicated preview gallery", async () => {
    const imageOne =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='200'/%3E";
    const imageTwo =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'/%3E";
    const { container, getByLabelText, getByTestId } = render(
      <TestQueryProvider>
        <ThreadGeneratedImageGalleryBlock
          block={{
            id: "generated-image-gallery",
            turnId: "turn-1",
            createdAt: 1,
            updatedAt: 2,
            searchableText: "",
            type: "generatedImageGallery",
            images: [
              { id: "generated-image-1", previewSrc: imageOne, src: imageTwo },
              { id: "generated-image-2", src: imageTwo },
            ],
            pendingImageCount: 1,
          }}
          isLatestTurn
          isStreamingTurn
        />
      </TestQueryProvider>,
    );

    expect(Boolean(getByTestId("generated-image-gallery"))).toBe(true);
    expect(container.querySelectorAll('[data-testid="generated-image-preview"]').length).toBe(2);
    expect(Boolean(container.querySelector('[aria-label="Generating image..."]'))).toBe(true);
    expect(getByLabelText("Generated image 1").querySelector("img")?.getAttribute("src")).toBe(
      imageOne,
    );
    const setDragData = vi.fn();
    fireEvent.dragStart(
      getByLabelText("Generated image 1").querySelector("img") as HTMLImageElement,
      {
        dataTransfer: { effectAllowed: "none", setData: setDragData },
      },
    );
    expect(setDragData).toHaveBeenCalledWith(
      "application/x-codex-image",
      JSON.stringify({ filename: "generated-image-1", src: imageTwo }),
    );

    await act(async () => {
      fireEvent.click(getByLabelText("Generated image 1"));
      await Promise.resolve();
    });
    expect(Boolean(getByLabelText("Image preview"))).toBe(true);
    expect(getByLabelText("Image preview").querySelector("img")?.getAttribute("src")).toBe(
      imageTwo,
    );
    expect(getByLabelText("Download image").getAttribute("type")).toBe("button");
  });

  test("refetches a failed generated-image preview at most twice for its resolved source", async () => {
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:stable-image-source");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      dataBase64: "aW1hZ2U=",
      mimeType: "image/png",
    });
    installWindowApi({ invoke });
    try {
      const { findByLabelText } = render(
        <TestQueryProvider>
          <ThreadGeneratedImageGalleryBlock
            block={{
              id: "generated-image-gallery",
              turnId: "turn-1",
              createdAt: 1,
              updatedAt: 2,
              searchableText: "",
              type: "generatedImageGallery",
              images: [{ id: "generated-image-1", src: "file-service://asset-1" }],
              pendingImageCount: 0,
            }}
            isLatestTurn
            isStreamingTurn={false}
          />
        </TestQueryProvider>,
      );
      const preview = await findByLabelText("Generated image 1");
      const image = preview.querySelector("img") as HTMLImageElement;
      expect(invoke).toHaveBeenCalledTimes(1);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await act(async () => {
          fireEvent.error(image);
          await Promise.resolve();
        });
        await waitFor(() => {
          expect(invoke).toHaveBeenCalledTimes(Math.min(attempt + 2, 3));
        });
      }
    } finally {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });

  test("moves the generated-image carousel one slot and restores focus on pointer release", async () => {
    const measurement = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 74,
      height: 74,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const source =
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'/%3E";
    try {
      const { getByLabelText } = render(
        <TestQueryProvider>
          <ThreadGeneratedImageGalleryBlock
            block={{
              id: "generated-image-carousel",
              turnId: "turn-1",
              createdAt: 1,
              updatedAt: 2,
              searchableText: "",
              type: "generatedImageGallery",
              images: Array.from({ length: 6 }, (_, index) => ({
                id: `generated-image-${index + 1}`,
                src: source,
              })),
              pendingImageCount: 0,
            }}
            isLatestTurn
            isStreamingTurn={false}
          />
        </TestQueryProvider>,
      );
      await waitFor(() => {
        expect((getByLabelText("Next images") as HTMLButtonElement).disabled).toBe(false);
      });
      const previousButton = getByLabelText("Previous images") as HTMLButtonElement;
      const nextButton = getByLabelText("Next images") as HTMLButtonElement;
      expect(previousButton.disabled).toBe(true);

      await act(async () => {
        fireEvent.click(nextButton);
        nextButton.focus();
        expect(document.activeElement).toBe(nextButton);
        fireEvent.pointerUp(nextButton);
        await Promise.resolve();
      });

      expect(previousButton.disabled).toBe(false);
      expect(getByLabelText("Generated image 1").getAttribute("aria-hidden")).toBe("true");
      expect(document.activeElement === nextButton).toBe(false);
    } finally {
      measurement.mockRestore();
    }
  });

  test("renders completed MCP elicitation as a collapsed question-and-answer disclosure", async () => {
    const { container, getByText } = render(
      <ThreadMcpServerElicitationBlock
        block={{
          id: "elicitation-1",
          turnId: "turn-1",
          createdAt: 1,
          updatedAt: 2,
          searchableText: "Allow the connector action? Accepted",
          type: "mcpServerElicitation",
          status: "completed",
          entry: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "elicitation-1",
            type: "mcpServerElicitation",
            kind: "systemEvent",
            semanticKind: "mcpServerElicitation",
            status: "completed",
            rawItem: {
              type: "mcpServerElicitation",
              completed: true,
              requestId: "request-1",
              action: "accept",
              elicitation: { kind: "mcpToolCall", message: "Allow the connector action?" },
            },
            createdAt: 1,
            updatedAt: 2,
          },
        }}
        isLatestTurn
        isStreamingTurn={false}
      />,
    );

    const collapsedBody = container.querySelector('[aria-hidden="true"][inert]');
    expect(collapsedBody?.getAttribute("inert")).toBe("");
    fireEvent.click(container.querySelector('button[aria-expanded="false"]') as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector('[aria-hidden="false"]') !== null).toBe(true);
    });
    getByText("Allow the connector action?");
    getByText("Accepted");
  });
});

describe("ThreadTurnDiffBlock", () => {
  test("renders the compact Codex above-composer banner while the turn is streaming", () => {
    let selectedTurnId: string | null = null;
    const { container, getByText } = render(
      <ThreadTurnDiffBlock
        block={{
          id: "turn-diff-portal",
          turnId: "turn-1",
          createdAt: 1,
          updatedAt: 1,
          searchableText: "4 files changed",
          type: "turnDiff",
          entry: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "turn-diff-portal",
            entryId: "turn-diff-portal",
            type: "turn_diff",
            kind: "systemEvent",
            semanticKind: "diff",
            status: "completed",
            rawItem: {
              type: "turn-diff",
              cwd: "/tmp/project",
              unifiedDiff: [
                "--- a/src/one.ts",
                "+++ b/src/one.ts",
                "@@ -1 +1 @@",
                "-old",
                "+new",
                "--- a/src/two.ts",
                "+++ b/src/two.ts",
                "@@ -1 +1 @@",
                "-old2",
                "+new2",
              ].join("\n"),
            },
            createdAt: 1,
            updatedAt: 1,
          },
        }}
        isLatestTurn={true}
        isStreamingTurn={true}
        allowInProgressTurnDiff={true}
        threadCwd="/tmp/project"
        onOpenTurnDiffReview={(target) => {
          selectedTurnId =
            target.source.kind === "selected-turn"
              ? target.source.turnId
              : target.source.kind === "last-turn"
                ? target.source.threadId
                : target.source.kind;
        }}
      />,
    );

    getByText("2 files changed");
    expect(Boolean(container.querySelector('[codex\\.turn_diff\\.state="in_progress"]'))).toBe(
      true,
    );
    expect(container.querySelectorAll('[role="button"][aria-expanded="false"]').length).toBe(0);
    fireEvent.click(container.querySelector("button") as HTMLElement);
    expect(selectedTurnId).toBe("thread-1");
  });

  test("suppresses in-progress turn diffs in the normal thread body", () => {
    const { container } = render(
      <ThreadTurnDiffBlock
        block={{
          id: "turn-diff-body",
          turnId: "turn-1",
          createdAt: 1,
          updatedAt: 1,
          searchableText: "1 file changed",
          type: "turnDiff",
          entry: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "turn-diff-body",
            entryId: "turn-diff-body",
            type: "turn_diff",
            kind: "systemEvent",
            semanticKind: "diff",
            status: "inProgress",
            rawItem: {
              type: "turn-diff",
              unifiedDiff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
            },
            createdAt: 1,
            updatedAt: 1,
          },
        }}
        isLatestTurn={true}
        isStreamingTurn={true}
      />,
    );

    expect(container.textContent ?? "").toBe("");
  });

  test("suppresses completed turn diffs in prose detail mode", () => {
    localStorage.setItem(
      THREAD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ detailLevel: "STEPS_PROSE" }),
    );
    try {
      const { container } = render(
        <CodexThreadSettingsProvider>
          <ThreadTurnDiffBlock
            block={{
              id: "turn-diff-completed-prose",
              turnId: "turn-1",
              createdAt: 1,
              updatedAt: 1,
              searchableText: "1 file changed",
              type: "turnDiff",
              entry: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "turn-diff-completed-prose",
                entryId: "turn-diff-completed-prose",
                type: "turn_diff",
                kind: "systemEvent",
                semanticKind: "diff",
                status: "completed",
                rawItem: {
                  type: "turn-diff",
                  unifiedDiff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
                },
                createdAt: 1,
                updatedAt: 1,
              },
            }}
            isLatestTurn={true}
            isStreamingTurn={false}
          />
        </CodexThreadSettingsProvider>,
      );

      expect(container.textContent ?? "").toBe("");
    } finally {
      localStorage.removeItem(THREAD_SETTINGS_STORAGE_KEY);
    }
  });
});
