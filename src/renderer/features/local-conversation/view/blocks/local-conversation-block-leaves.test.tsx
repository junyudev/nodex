import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { CodexConversationItem } from "../../../../lib/types";
import { NodexTooltipProvider as TooltipProvider } from "../../../../components/ui/tooltip";
import { ContentImageScopeProvider, THIS_COMPUTER_IMAGE_SCOPE } from "@/lib/content-image";
import { installMeasuredResizeObserver, installWindowApi } from "../../../../test/browser-globals";
import { renderWithMaitai } from "../../../../test/thread-maitai";
import { textContent } from "../../../../test/dom";
import { TestQueryProvider } from "../../../../test/query";
import { projectCodexCanonicalTurnItemViews } from "../../../../../shared/codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../../../../../shared/codex-transcript-entry-projection";
import { projectAgentRuntimeItem } from "../../agent-runtime-transcript-projection";
import { buildRendererItemStream } from "../../projection/build-renderer-item-stream";
import {
  ThreadContextCompactionBlock,
  ThreadAgentActivityGroupBlock,
  ThreadGeneratedImageGalleryBlock,
  ThreadPlanCardBlock,
  ThreadTurnDiffBlock,
  UserMessageBubble,
} from "./local-conversation-block-leaves";
import { ThreadBlockRenderer } from "./local-conversation-block-renderer";
import { CODEX_SHIMMER_CADENCE_MS } from "../shared/codex-shimmer-text";
import { ConversationImageInputContext } from "../../conversation-image-input";
import { HookFeedbackSettingsNavigationProvider } from "../hook-feedback-settings-navigation";
import { useLocalConversationEditingTurnIds } from "../local-conversation-thread-view-state";
import type {
  ThreadAgentActivityGroupBlockModel,
  ThreadAgentActivityGroupEntryModel,
  ThreadOpenThreadContext,
  ThreadTranscriptBlockModel,
} from "../../thread-stage-types";

const { toastFailureMock } = vi.hoisted(() => ({ toastFailureMock: vi.fn() }));
vi.mock("@/lib/failure-toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/failure-toast")>()),
  toastFailure: toastFailureMock,
}));

// Thread leaves read Library and host images through the app's query client.
const render: typeof renderWithMaitai = (ui, options) =>
  renderWithMaitai(ui, { wrapper: TestQueryProvider, ...options });

const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const originalGetComputedStyle = window.getComputedStyle;

function EditingTurnIdsProbe({ onChange }: { onChange: (turnIds: readonly string[]) => void }) {
  const turnIds = useLocalConversationEditingTurnIds("thread-1");
  useLayoutEffect(() => {
    onChange(turnIds);
  }, [onChange, turnIds]);
  return null;
}

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
    header: overrides.header ?? { kind: "summary" },
    status: overrides.status ?? "completed",
    ...overrides,
    stepImages: overrides.stepImages ?? entries.flatMap((entry) => entry.entry.stepImages ?? []),
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
        canOpen: true,
        conversationId: "thread-child-1",
        identityThreadId: "thread-child-1",
        displayName: "Scout",
        agentRole: null,
        spawnModel: null,
        status: "active",
        activityStatus: "updated",
        statusSummary: "Scout updated",
        diffStats: null,
      },
      {
        canOpen: true,
        conversationId: "thread-child-2",
        identityThreadId: "thread-child-2",
        displayName: "Reviewer",
        agentRole: null,
        spawnModel: null,
        status: "active",
        activityStatus: "started",
        statusSummary: "Reviewer started working",
        diffStats: null,
      },
      {
        canOpen: true,
        conversationId: "thread-child-3",
        identityThreadId: "thread-child-3",
        displayName: "Builder",
        agentRole: null,
        spawnModel: null,
        status: "done",
        activityStatus: "done",
        statusSummary: "Builder finished",
        diffStats: null,
      },
      {
        canOpen: true,
        conversationId: "thread-child-4",
        identityThreadId: "thread-child-4",
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

describe("UserMessageBubble images", () => {
  const first = "data:image/png;base64,Zmlyc3Q=";
  const second = "data:image/png;base64,c2Vjb25k";
  const block = (text: string): ThreadTranscriptBlockModel => {
    const built = buildUserMessageBlock(text);
    return {
      ...built,
      entry: {
        ...built.entry,
        userAttachments: [
          { type: "image", id: "attached", source: first, sourceKind: "inline-image" },
          { type: "image", id: "written", source: second, sourceKind: "inline-image" },
        ],
      },
    } as ThreadTranscriptBlockModel;
  };

  test("shows an image where the Agent read it and opens it in the message's viewer", async () => {
    const view = render(
      <TooltipProvider>
        <UserMessageBubble
          block={block("Compare it with [Image #2] (caption: shot; path: /tmp/shot.png)")}
          isLatestTurn={false}
          isStreamingTurn={false}
        />
      </TooltipProvider>,
    );
    const reference = await view.findByRole("button", { name: "Open Image #2" });
    expect(reference.querySelector("img")?.getAttribute("src")).toBe(second);
    expect(view.queryByText(/caption: shot/u)).toBeNull();

    await act(async () => {
      fireEvent.click(reference);
      await Promise.resolve();
    });
    const dialog = await view.findByRole("dialog", { name: "Image preview" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(second);
    // The viewer holds every image of the message, the attached one first.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Previous image" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(dialog.querySelector("img")?.getAttribute("src")).toBe(first));
  });

  test("a placeholder that names no image of the message stays a plain reference", async () => {
    const view = render(
      <TooltipProvider>
        <UserMessageBubble
          block={block("[Image #1] then [Image #3], which could not be sent")}
          isLatestTurn={false}
          isStreamingTurn={false}
        />
      </TooltipProvider>,
    );
    await view.findAllByRole("button", { name: "Open image preview" });
    expect(view.queryByRole("button", { name: /Open Image #/u })).toBeNull();
    expect(view.getByText("Image #3")).toBeDefined();
  });
});

describe("UserMessageBubble collapse", () => {
  afterEach(() => {
    restoreTextCollapseMeasurement();
  });

  describe("names the conversation that sent or answered", () => {
    afterEach(() => vi.restoreAllMocks());

    test("names the Automation that sent a heartbeat and opens it, and keeps a deleted one anonymous", async () => {
      installWindowApi({
        invoke: vi
          .fn()
          .mockResolvedValue({ items: [{ id: "automation-1", name: "Release watch" }] }),
        on: () => () => {},
      });
      const onOpenSummaryAutomation = vi.fn();
      const renderHeartbeat = (automationId: string) => {
        const block = buildUserMessageBlock("Check the release branch");
        block.entry.userMessageOrigin = { kind: "automation", automationId };
        return render(
          <UserMessageBubble
            block={block}
            isLatestTurn
            isStreamingTurn={false}
            onOpenSummaryAutomation={onOpenSummaryAutomation}
          />,
        );
      };
      const view = renderHeartbeat("automation-1");
      const open = await view.findByRole("button", { name: "Open Release watch" });
      expect(
        view.container.querySelector('[data-user-message-origin="automation"]')!.textContent,
      ).toBe("Sent byRelease watch");
      await act(async () => {
        fireEvent.click(open);
        await Promise.resolve();
      });
      expect(onOpenSummaryAutomation).toHaveBeenCalledWith(
        expect.objectContaining({ automationId: "automation-1" }),
      );
      view.unmount();

      const deleted = renderHeartbeat("automation-gone");
      const marker = deleted.container.querySelector('[data-user-message-origin="automation"]')!;
      expect(marker.textContent).toBe("Sent byAutomation");
      expect(marker.querySelector("button")).toBeNull();
    });
  });

  test("renders submit-hook explanations and navigates to their source", async () => {
    const block = buildUserMessageBlock("Blocked request");
    block.entry.deliveryStatus = "not-sent";
    block.userMessageActions = {
      canEdit: false,
      sentAtMs: null,
      hookStats: {
        count: 1,
        blockedCount: 1,
        errorCount: 0,
        entries: [],
        runs: [],
        blockedSources: ["project"],
        blockedMessages: ["Fix the check\nThen retry"],
      },
    };
    const onOpenHooksSettings = vi.fn();
    const { getByRole, getByText } = render(
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
    expect(getByText("Fix the check Then retry").textContent).toBe("Fix the check\nThen retry");
    const link = getByRole("link", { name: "Hook blocked this message" });
    await act(async () => {
      fireEvent.click(link);
      await Promise.resolve();
    });
    expect(onOpenHooksSettings).toHaveBeenCalledWith({
      hostId: "remote-1",
      selection: { source: "project", projectRoot: "/workspace/nodex" },
    });
  });

  test("keeps a failed edit retryable and closes the editor only after success", async () => {
    const block = buildUserMessageBlock("Original request");
    block.userMessageActions = { canEdit: true, sentAtMs: null };
    let rejectFirst: (error: Error) => void = () => {};
    let completeRetry: () => void = () => {};
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const retry = new Promise<void>((resolve) => {
      completeRetry = resolve;
    });
    const onEditUserTurn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(retry);
    const editingTurnIds: Array<readonly string[]> = [];
    const { getByRole, queryByRole } = render(
      <TooltipProvider>
        <EditingTurnIdsProbe onChange={(ids) => editingTurnIds.push(ids)} />
        <UserMessageBubble
          block={block}
          isLatestTurn
          isStreamingTurn={false}
          onEditUserTurn={onEditUserTurn}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Edit message" }));
    });
    expect(editingTurnIds.at(-1)).toEqual(["turn-1"]);
    const input = getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "  Revised request  " } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.submit(input.form!);
      await Promise.resolve();
    });
    expect(onEditUserTurn).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1",
      turnId: "turn-1",
      message: "Revised request",
      images: [],
    });
    expect((getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      rejectFirst(new Error("Edit failed"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect((getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect((getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement).value).toBe(
      "  Revised request  ",
    );
    expect(editingTurnIds.at(-1)).toEqual(["turn-1"]);
    await act(async () => {
      fireEvent.submit(input.form!);
      await Promise.resolve();
    });
    expect(onEditUserTurn).toHaveBeenCalledTimes(2);
    expect(queryByRole("textbox", { name: "Edit message" })).not.toBeNull();
    await act(async () => {
      completeRetry();
      await Promise.resolve();
    });
    await waitFor(() => expect(queryByRole("textbox", { name: "Edit message" })).toBeNull());
    expect(editingTurnIds.at(-1)).toEqual([]);
  });

  test("edits with the Composer's keys and keeps the draft while the message scrolls away", async () => {
    const block = buildUserMessageBlock("Original request");
    block.userMessageActions = { canEdit: true, sentAtMs: null };
    const onEditUserTurn = vi.fn().mockResolvedValue(undefined);
    const editingTurnIds: Array<readonly string[]> = [];
    const bubble = (visible: boolean) => (
      <TooltipProvider>
        <EditingTurnIdsProbe onChange={(ids) => editingTurnIds.push(ids)} />
        {visible ? (
          <UserMessageBubble
            block={block}
            isLatestTurn={false}
            isStreamingTurn={false}
            onEditUserTurn={onEditUserTurn}
          />
        ) : null}
      </TooltipProvider>
    );
    const { getByRole, queryByRole, rerender } = render(bubble(true));
    const editor = () => getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Edit message" }));
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(editor());
    expect(editor().selectionStart).toBe("Original request".length);
    await act(async () => {
      fireEvent.change(editor(), { target: { value: "Rewritten request" } });
      fireEvent.keyDown(editor(), { key: "Enter", shiftKey: true });
      await Promise.resolve();
    });
    expect(onEditUserTurn).not.toHaveBeenCalled();

    rerender(bubble(false));
    rerender(bubble(true));
    expect(editor().value).toBe("Rewritten request");

    await act(async () => {
      fireEvent.keyDown(editor(), { key: "Escape" });
      await Promise.resolve();
    });
    expect(queryByRole("textbox", { name: "Edit message" })).toBeNull();
    expect(editingTurnIds.at(-1)).toEqual([]);
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Edit message" }));
      await Promise.resolve();
    });
    expect(editor().value).toBe("Original request");

    await act(async () => {
      fireEvent.change(editor(), { target: { value: "Rewritten request" } });
      fireEvent.keyDown(editor(), { key: "Enter" });
      await Promise.resolve();
    });
    expect(onEditUserTurn).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1",
      turnId: "turn-1",
      message: "Rewritten request",
      images: [],
    });
    await waitFor(() => expect(queryByRole("textbox", { name: "Edit message" })).toBeNull());
    expect(editingTurnIds.at(-1)).toEqual([]);
  });

  describe("while the message is rewritten", () => {
    // This environment has no DataTransfer; these are the parts a transfer of one file reads.
    const fileTransfer = (name: string) => {
      const file = new File(["pixels"], name, { type: "image/png" });
      return {
        files: [file],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
        types: ["Files"],
        getData: () => "",
        dropEffect: "none",
      };
    };
    const pasteImage = (target: HTMLElement, name = "pasted.png") =>
      act(async () => {
        fireEvent.paste(target, { clipboardData: fileTransfer(name) });
        await Promise.resolve();
      });
    const open = async (
      text: string,
      attachments: NonNullable<ThreadTranscriptBlockModel["entry"]["userAttachments"]>,
      onEditUserTurn = vi.fn().mockResolvedValue(undefined),
    ) => {
      const built = buildUserMessageBlock(text);
      const block = {
        ...built,
        entry: { ...built.entry, userAttachments: attachments },
        userMessageActions: { canEdit: true, sentAtMs: null },
      } as ThreadTranscriptBlockModel;
      const view = render(
        <TooltipProvider>
          <UserMessageBubble
            block={block}
            isLatestTurn
            isStreamingTurn={false}
            onEditUserTurn={onEditUserTurn}
          />
        </TooltipProvider>,
      );
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit message" }));
        await Promise.resolve();
      });
      const editor = view.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;
      return { view, editor, onEditUserTurn };
    };
    const send = (editor: HTMLTextAreaElement) =>
      act(async () => {
        fireEvent.submit(editor.form!);
        await Promise.resolve();
      });
    const attached = (id: string, source: string) =>
      ({ type: "image", id, source, sourceKind: "inline-image" }) as const;
    const first = "data:image/png;base64,Zmlyc3Q=";
    const second = "data:image/png;base64,c2Vjb25k";

    test("sends what the message keeps, and takes what named a removed image out of its text", async () => {
      const { view, editor, onEditUserTurn } = await open("Compare with [Image #2]", [
        attached("a", first),
        attached("b", second),
      ]);
      // The images move into the form, so they appear once, each removable.
      expect(await view.findByRole("button", { name: "Remove Image #1" })).toBeTruthy();
      expect(view.getAllByRole("img", { name: "User attachment" })).toHaveLength(2);

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Remove Image #1" }));
        await Promise.resolve();
      });
      expect(editor.value).toBe("Compare with [Image #1]");
      expect(view.getAllByRole("img", { name: "User attachment" })).toHaveLength(1);
      // Removing an image is not a reason to take focus from the text.
      expect(document.activeElement).toBe(editor);

      await send(editor);
      expect(onEditUserTurn).toHaveBeenCalledExactlyOnceWith({
        threadId: "thread-1",
        turnId: "turn-1",
        message: "Compare with [Image #1]",
        images: [{ source: second }],
      });
    });

    test("removing every image sends none, while Cancel puts them all back", async () => {
      const { view, editor, onEditUserTurn } = await open("Words", [attached("a", first)]);
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Remove Image #1" }));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.keyDown(editor, { key: "Escape" });
        await Promise.resolve();
      });
      expect(onEditUserTurn).not.toHaveBeenCalled();
      expect(view.queryByRole("textbox", { name: "Edit message" })).toBeNull();
      await waitFor(() =>
        expect(view.getAllByRole("img", { name: "User attachment" })).toHaveLength(1),
      );

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit message" }));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Remove Image #1" }));
        await Promise.resolve();
      });
      await send(view.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement);
      expect(onEditUserTurn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Words", images: [] }),
      );
    });

    test("says why when the conversation's model cannot take an image", async () => {
      const built = buildUserMessageBlock("Words");
      const view = render(
        <TooltipProvider>
          <ConversationImageInputContext
            value={{ supported: false, unavailableReason: "This model reads no images." }}
          >
            <UserMessageBubble
              block={{ ...built, userMessageActions: { canEdit: true, sentAtMs: null } }}
              isLatestTurn
              isStreamingTurn={false}
              onEditUserTurn={vi.fn()}
            />
          </ConversationImageInputContext>
        </TooltipProvider>,
      );
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit message" }));
        await Promise.resolve();
      });
      await pasteImage(view.getByRole("textbox", { name: "Edit message" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(view.queryByRole("button", { name: /^Remove / })).toBeNull();
      expect(toastFailureMock).toHaveBeenCalledWith("This model reads no images.");
    });

    test("keeps its images and added ones while the message scrolls away", async () => {
      const built = buildUserMessageBlock("Words");
      const block = {
        ...built,
        entry: { ...built.entry, userAttachments: [attached("a", first), attached("b", second)] },
        userMessageActions: { canEdit: true, sentAtMs: null },
      } as ThreadTranscriptBlockModel;
      const bubble = (visible: boolean) => (
        <TooltipProvider>
          {visible ? (
            <UserMessageBubble
              block={block}
              isLatestTurn
              isStreamingTurn={false}
              onEditUserTurn={vi.fn()}
            />
          ) : null}
        </TooltipProvider>
      );
      const view = render(bubble(true));
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit message" }));
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Remove Image #1" }));
        await Promise.resolve();
      });
      await pasteImage(view.getByRole("textbox", { name: "Edit message" }));
      await view.findByRole("button", { name: "Remove pasted.png" });

      view.rerender(bubble(false));
      view.rerender(bubble(true));
      expect(await view.findByRole("button", { name: "Remove pasted.png" })).toBeTruthy();
      expect(view.getByRole("button", { name: "Remove Image #1" })).toBeTruthy();
      expect(view.queryByRole("button", { name: "Remove Image #2" })).toBeNull();
    });
  });

  test("does not send an emptied edit", async () => {
    const block = buildUserMessageBlock("Original request");
    block.userMessageActions = { canEdit: true, sentAtMs: null };
    const onEditUserTurn = vi.fn();
    const { getByRole } = render(
      <TooltipProvider>
        <UserMessageBubble
          block={block}
          isLatestTurn
          isStreamingTurn={false}
          onEditUserTurn={onEditUserTurn}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Edit message" }));
      await Promise.resolve();
    });
    const editor = getByRole("textbox", { name: "Edit message" });
    await act(async () => {
      fireEvent.change(editor, { target: { value: "   " } });
      fireEvent.keyDown(editor, { key: "Enter" });
      await Promise.resolve();
    });
    expect((getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onEditUserTurn).not.toHaveBeenCalled();
  });
});

describe("ThreadAgentActivityGroupBlock", () => {
  /** The header's visible label sits beside its overlay toggle, not inside it. */

  function activeHeader(item: ThreadAgentActivityGroupEntryModel, label: string) {
    return {
      kind: "active" as const,
      item,
      label,
      labelKey: `${item.type}:${label}`,
      inProgress: true,
    };
  }

  test("hands a new label over only after the current sweep, then releases the old one", async () => {
    vi.useFakeTimers();
    // Sweeps run only on screen; give the header a visible box.
    let rectOwner: object | null = document.createElement("span");
    while (rectOwner && !Object.hasOwn(rectOwner, "getBoundingClientRect")) {
      rectOwner = Object.getPrototypeOf(rectOwner) as object | null;
    }
    const onScreen = vi.spyOn(rectOwner as Element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 320,
      bottom: 20,
      width: 320,
      height: 20,
    } as DOMRect);
    const shown = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    try {
      const buildBlock = (key: string, label: string) => {
        const commandBlock = buildCommandBlock(key, [], {
          status: "inProgress",
          command: label.replace(/^Running /, ""),
          exitCode: undefined,
        });
        return buildAgentActivityGroupBlock({
          id: "activity-handoff",
          searchableText: label,
          status: "inProgress",
          entries: [commandBlock],
          completedHeader: { parts: [{ kind: "commands", count: 1 }], iconItem: commandBlock },
          header: activeHeader(commandBlock, label),
        });
      };
      const renderGroup = (block: ThreadAgentActivityGroupBlockModel) => (
        <TooltipProvider>
          <ThreadAgentActivityGroupBlock block={block} isLatestTurn={true} isStreamingTurn={true} />
        </TooltipProvider>
      );
      const view = render(renderGroup(buildBlock("first", "Running first command")));
      const status = () => view.container.querySelector<HTMLElement>("[role='status']")!;
      expect(textContent(status()).includes("Running first command")).toBe(true);

      // The first label is still sweeping in, so the next one waits for it.
      view.rerender(renderGroup(buildBlock("second", "Running second command")));
      expect(textContent(status()).includes("Running second command")).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(CODEX_SHIMMER_CADENCE_MS.activeDuration);
        await Promise.resolve();
      });
      const outgoing = status().querySelector<HTMLElement>("[aria-hidden='true'][inert]");
      expect(textContent(outgoing!)).toBe("Running first command");
      expect(textContent(status()).includes("Running second command")).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(CODEX_SHIMMER_CADENCE_MS.activeDuration);
        await Promise.resolve();
      });
      expect(status().querySelector("[inert]")).toBe(null);
      expect(textContent(status()).includes("Running first command")).toBe(false);

      // The same command running again keeps its label in place.
      view.rerender(renderGroup(buildBlock("third", "Running second command")));
      expect(status().querySelector("[inert]")).toBe(null);
    } finally {
      shown.mockRestore();
      onScreen.mockRestore();
      vi.useRealTimers();
    }
  });
});

function buildContextCompactionBlock(
  contextCompaction: NonNullable<CodexConversationItem["contextCompaction"]>,
): Parameters<typeof ThreadContextCompactionBlock>[0]["block"] {
  return {
    id: "compact-1",
    turnId: "turn-1",
    createdAt: 1,
    updatedAt: 1,
    searchableText: "",
    type: "contextCompaction",
    status: contextCompaction.status,
    entry: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "compact-1",
      type: "context_compaction",
      kind: "systemEvent",
      semanticKind: "contextCompaction",
      status: contextCompaction.status,
      contextCompaction,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

describe("ThreadContextCompactionBlock", () => {
  test("reassures after a compaction has been running for ten seconds", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    try {
      vi.setSystemTime(100_000);
      const { getByText } = render(
        <ThreadContextCompactionBlock
          block={buildContextCompactionBlock({
            status: "inProgress",
            source: "automatic",
            startedAtMs: 96_000,
          })}
          isLatestTurn={true}
          isStreamingTurn={true}
        />,
      );

      getByText("Compacting context", { selector: ".loading-shimmer-pure-text" });
      await act(async () => {
        vi.advanceTimersByTime(6_000);
        await Promise.resolve();
      });
      getByText("Compacting context · This can take a few minutes", {
        selector: ".loading-shimmer-pure-text",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ThreadPlanCardBlock", () => {
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

describe("ThreadBlockRenderer subagent activity block", () => {
  test("keeps sentence names and overflow avatars independently keyboard accessible", async () => {
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
    const buttons = group.querySelectorAll("button, [role=button]");

    expect(Boolean(group)).toBe(true);
    expect(buttons.length).toBe(4);
    expect(group.textContent).toBe("Scout, Reviewer and 2 more updated");
    expect(Boolean(view.queryByText("Tester"))).toBe(false);
    expect(view.container.querySelectorAll("[data-animate-entrance]").length).toBe(2);
    expect(
      Boolean(view.container.querySelector('[data-subagent-avatar-seed="thread-child-1"]')),
    ).toBe(true);

    expect(group.getAttribute("role")).toBe("status");
    expect(group.getAttribute("aria-live")).toBe("polite");
    await act(async () => {
      fireEvent.keyDown(view.getByRole("button", { name: "Scout" }), { key: "Enter" });
    });

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

describe("conversation recovery leaves", () => {
  function errorBlock(state: "retrying" | "recovered" | "failed"): ThreadTranscriptBlockModel {
    return {
      id: "error:turn-1",
      turnId: "turn-1",
      createdAt: 1,
      updatedAt: 1,
      searchableText: "Provider disconnected",
      type: state === "failed" ? "systemError" : "streamError",
      status: state === "retrying" ? "inProgress" : state === "failed" ? "failed" : "completed",
      entry: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "error:turn-1",
        type: "error",
        kind: "systemEvent",
        markdownText: "Provider disconnected",
        additionalDetails: "Request ID: request-1",
        recovery: {
          state,
          reason: "connection",
          attempt: 2,
          maxAttempts: 5,
          retryAt: null,
          updatedAt: 1,
        },
        createdAt: 1,
        updatedAt: 1,
      },
    };
  }

  test("updates the mounted retry row on recovery and keeps expanded diagnostics available", async () => {
    const view = render(
      <TooltipProvider>
        <ThreadBlockRenderer block={errorBlock("retrying")} isLatestTurn isStreamingTurn />
      </TooltipProvider>,
    );
    const disclosure = await view.findByRole("button", { name: "Reconnecting · 2/5" });
    expect(view.queryByRole("region", { name: "Recovery diagnostics" })).toBeNull();
    await act(async () => {
      fireEvent.click(disclosure);
    });
    const diagnostics = view.getByRole("region", { name: "Recovery diagnostics" });
    expect(diagnostics.textContent).toContain("Request ID: request-1");
    view.rerender(
      <TooltipProvider>
        <ThreadBlockRenderer block={errorBlock("recovered")} isLatestTurn isStreamingTurn />
      </TooltipProvider>,
    );
    expect(
      view.getByRole("button", { name: "Connection restored" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(view.queryByRole("button", { name: /Reconnecting/ })).toBeNull();
    view.rerender(
      <TooltipProvider>
        <ThreadBlockRenderer block={errorBlock("failed")} isLatestTurn isStreamingTurn={false} />
      </TooltipProvider>,
    );
    expect(
      view
        .getByRole("button", { name: "Connection could not be restored" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(view.getByRole("region", { name: "Recovery diagnostics" }).textContent).toContain(
      "Request ID: request-1",
    );
  });
});

describe("image-view and completed elicitation leaves", () => {
  beforeEach(() => {
    installWindowApi({ on: () => () => {} });
    installMeasuredResizeObserver({ blockSize: 72, inlineSize: 320 });
  });

  test("shows completed runtime image reads on one row by the kept copies of their files", async () => {
    const paths = ["/workspace/rail-states-light.png", "/workspace/rail-states-dark.png"];
    const at = "2026-10-23T00:00:00.000Z";
    const read = (path: string, ordinal: number, kept: boolean): AgentTurnItem => ({
      id: `read-${ordinal}`,
      threadId: "thread-1",
      runId: "turn-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      title: `Read ${path}`,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "dynamic_tool",
      toolName: "Read",
      viewedImagePath: path,
      input: { file_path: path },
      output: { type: "image", file: { type: "image/png", sizeBytes: 128 } },
      ...(kept
        ? {
            attachments: [
              {
                type: "image" as const,
                id: `copy-${ordinal}`,
                name: path.split("/").at(-1)!,
                mimeType: "image/png",
                sizeBytes: 128,
              },
            ],
          }
        : {}),
    });
    const project = (items: readonly AgentTurnItem[]) =>
      buildRendererItemStream({
        entries: projectCodexCanonicalTurnItemViews({
          threadId: "thread-1",
          turnId: "turn-1",
          items: items.flatMap((item) => projectAgentRuntimeItem(item) ?? []),
          observedAtMs: 1,
          turnStatus: "completed",
        }).map((view, index) => projectCodexItemViewToTranscriptEntry(view, "replay", index)),
        requests: [],
        turnStatus: "completed",
      });

    // A read whose picture was never kept stays the file read it was.
    expect(project([read(paths[0]!, 0, false)]).map((block) => block.type)).toEqual([
      "dynamicToolCall",
    ]);

    const blocks = project(paths.map((path, ordinal) => read(path, ordinal, true)));
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.type !== "imageView") throw new Error("Expected completed reads to form one row");
    const resolveRuntimeAttachment = vi.fn(async () => "data:image/png;base64,Zmlyc3Q=");
    const view = render(
      <TestQueryProvider>
        <TooltipProvider>
          <ContentImageScopeProvider
            scope={{
              ...THIS_COMPUTER_IMAGE_SCOPE,
              conversationId: "thread-1",
              hostId: "local",
              resolveRuntimeAttachment,
            }}
          >
            <ThreadBlockRenderer block={block} isLatestTurn isStreamingTurn={false} />
          </ContentImageScopeProvider>
        </TooltipProvider>
      </TestQueryProvider>,
    );

    // The pictures are on the row already; there is nothing to open.
    expect(view.getByText("Viewed 2 images")).toBeTruthy();
    expect(view.getByTestId("image-view-activity").querySelector("[aria-expanded]")).toBeNull();
    const thumbnails = await view.findAllByRole("button", { name: /^Open rail-states-/ });
    expect(thumbnails.map((thumbnail) => thumbnail.getAttribute("aria-label"))).toEqual([
      "Open rail-states-light.png",
      "Open rail-states-dark.png",
    ]);
    expect(resolveRuntimeAttachment).toHaveBeenCalledTimes(2);
  });

  test("refetches a failed generated-image preview at most twice for its resolved source", async ({
    onTestFinished,
  }) => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:asset-1");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    onTestFinished(() => {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    });
    const resolveImage = vi.fn(async (_input: { hostId: string; pointer: string }) => ({
      ok: true,
      dataBase64: "aW1hZ2U=",
      mimeType: "image/png",
    }));
    installWindowApi({
      invoke: async (channel: string, input: { hostId: string; pointer: string }) =>
        channel === "codex:conversation-image-asset:resolve" ? resolveImage(input) : null,
      on: () => () => {},
    });
    const source = "file-service://asset-1";
    const view = render(
      <TestQueryProvider>
        <ThreadGeneratedImageGalleryBlock
          block={{
            id: "generated-image-gallery",
            turnId: "turn-1",
            createdAt: 1,
            updatedAt: 2,
            searchableText: "",
            type: "generatedImageGallery",
            images: [{ id: "generated-image-1", src: source }],
            pendingImageCount: 0,
          }}
          isLatestTurn
          isStreamingTurn={false}
        />
      </TestQueryProvider>,
    );
    const image = () => view.findByRole("img", { name: "Generated image 1" });
    await image();
    const input = { hostId: "local", pointer: source };
    expect(resolveImage.mock.calls).toEqual([[input]]);

    for (const count of [2, 3, 3]) {
      const preview = await image();
      await act(async () => {
        fireEvent.error(preview);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(resolveImage.mock.calls).toEqual(Array.from({ length: count }, () => [input])),
      );
    }
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
});
