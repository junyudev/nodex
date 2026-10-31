import { beforeEach, describe, expect, test } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import { act, useState } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CommandPaletteThread } from "@/lib/command-palette";
import type { CodexThreadSummary } from "@/lib/types";
import {
  TEXT_ACTION_RECENT_COLOR_STORAGE_KEY,
  writeTextActionRecentColors,
} from "@/lib/text-action-color-recents";
import { render, settleAsyncRender } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import {
  NfmSendToThreadMenuSurface,
  type NfmSendToThreadMenuSurfaceProps,
} from "./nfm-send-to-thread-menu";
import type { NfmSendToThreadRequest } from "./nfm-send-to-thread-menu-model";
import {
  NfmTextActionMenuSurface,
  type NfmTextActionMenuSurfaceProps,
  type TextActionChat,
} from "./nfm-text-action-menu";

function makeSendToThreadItem(overrides: Partial<CommandPaletteThread> = {}): CommandPaletteThread {
  const threadId = overrides.threadId ?? "thread-existing";
  return {
    kind: "thread",
    id: overrides.id ?? `thread:${threadId}`,
    threadId,
    sessionId: overrides.sessionId === undefined ? "session-existing" : overrides.sessionId,
    projectId: overrides.projectId === undefined ? "default" : overrides.projectId,
    projectName: overrides.projectName === undefined ? "Default" : overrides.projectName,
    title: overrides.title ?? "Existing implementation",
    preview: overrides.preview ?? "Continue from selected notes",
    cwd: overrides.cwd ?? "/repo",
    gitBranch: overrides.gitBranch ?? null,
    projectless: overrides.projectless ?? false,
    pinned: overrides.pinned ?? false,
    pinnedOrder: overrides.pinnedOrder ?? null,
    statusType: overrides.statusType ?? "idle",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 2,
    inActiveProject: overrides.inActiveProject ?? true,
    searchPreview: overrides.searchPreview,
    searchDecorations: overrides.searchDecorations,
  };
}

function makePreferredThreadFromItem(
  item: CommandPaletteThread,
  overrides: Partial<CodexThreadSummary> = {},
): CodexThreadSummary {
  return {
    threadId: overrides.threadId ?? item.threadId,
    projectId: overrides.projectId ?? item.projectId,
    source: overrides.source ?? null,
    threadName: overrides.threadName ?? item.title,
    threadPreview: overrides.threadPreview ?? item.preview,
    modelProvider: "openai",
    cwd: overrides.cwd ?? item.cwd,
    statusType: overrides.statusType ?? "idle",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    archived: overrides.archived ?? false,
    createdAt: overrides.createdAt ?? item.createdAt,
    updatedAt: overrides.updatedAt ?? item.updatedAt,
    linkedAt: overrides.linkedAt ?? new Date(item.updatedAt).toISOString(),
    ...(overrides.ephemeral !== undefined ? { ephemeral: overrides.ephemeral } : {}),
  };
}

const SEND_TO_THREAD_THREADS = [
  makeSendToThreadItem(),
] satisfies NfmSendToThreadMenuSurfaceProps["threadItems"];

function renderTextActionMenu(
  props?: Partial<Omit<NfmTextActionMenuSurfaceProps, "chat">> & {
    readonly chat?: Partial<TextActionChat> | null;
  },
) {
  const actions = {
    blockTypes: [] as string[],
    styles: [] as string[],
    textColors: [] as string[],
    backgroundColors: [] as string[],
    clearFormat: 0,
    equations: 0,
    blockActions: 0,
    sendRequests: [] as NfmSendToThreadRequest[],
    composerAdds: 0,
    selectionPresentations: [] as string[],
  };

  const { chat: chatOverrides, ...surfaceProps } = props ?? {};
  const chat: TextActionChat | null =
    chatOverrides === null
      ? null
      : {
          projectId: "default",
          projectNameById: { default: "Default" },
          contextualTarget: null,
          onSend: (request) => {
            actions.sendRequests.push(request);
          },
          ...chatOverrides,
        };

  function StatefulTextActionMenuSurface() {
    const [, setRenderedSelectionPresentation] = useState("none");

    return (
      <NfmTextActionMenuSurface
        currentBlockTypeLabel="Normal Text"
        blockTypeItems={[
          {
            key: "paragraph",
            label: "Normal Text",
            type: "paragraph",
            isSelected: true,
          },
          {
            key: "heading-1",
            label: "Heading 1",
            type: "heading",
            props: { level: 1, isToggleable: false },
            isSelected: false,
          },
        ]}
        activeStyles={{
          bold: true,
          italic: false,
          underline: false,
          strike: false,
          code: false,
        }}
        textColor="default"
        backgroundColor="default"
        canUseTextColor={true}
        canUseBackgroundColor={true}
        canClearFormat={true}
        canConvertToEquation={true}
        linkControl={
          <button type="button" aria-label="Link">
            Link
          </button>
        }
        chat={chat}
        onSelectBlockType={(item) => {
          actions.blockTypes.push(item.key);
        }}
        onToggleStyle={(style) => {
          actions.styles.push(style);
        }}
        onSetTextColor={(color) => {
          actions.textColors.push(color);
        }}
        onSetBackgroundColor={(color) => {
          actions.backgroundColors.push(color);
        }}
        onClearFormat={() => {
          actions.clearFormat += 1;
        }}
        onConvertToEquation={() => {
          actions.equations += 1;
        }}
        onOpenBlockActions={() => {
          actions.blockActions += 1;
        }}
        {...surfaceProps}
        onSelectionPresentationChange={(presentation) => {
          actions.selectionPresentations.push(presentation);
          setRenderedSelectionPresentation(presentation);
          surfaceProps.onSelectionPresentationChange?.(presentation);
        }}
      />
    );
  }

  const view = render(
    <TestQueryProvider>
      <NodexTooltipProvider>
        <StatefulTextActionMenuSurface />
      </NodexTooltipProvider>
    </TestQueryProvider>,
  );

  return { actions, view };
}

describe("markdown text action menu surface", () => {
  beforeEach(() => {
    localStorage.removeItem(TEXT_ACTION_RECENT_COLOR_STORAGE_KEY);
  });

  async function openColorMenu(view: ReturnType<typeof renderTextActionMenu>["view"]) {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Color" }));
      await settleAsyncRender();
    });
  }

  function installFocusProbe() {
    const focusProbe = document.createElement("button");
    focusProbe.type = "button";
    focusProbe.textContent = "Focus probe";
    document.body.appendChild(focusProbe);
    focusProbe.focus();
    return focusProbe;
  }

  test("opens the block type menu and delegates Turn into selections", async () => {
    const { actions, view } = renderTextActionMenu();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Normal Text" }));
      await settleAsyncRender();
    });

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Heading 1" }));
      await settleAsyncRender();
    });

    expect(actions.blockTypes.join(",")).toBe("heading-1");
  });

  test("reports Block presentation while the block type picker is active", async () => {
    const { actions, view } = renderTextActionMenu();
    const trigger = view.getByRole("button", { name: "Normal Text" });

    await act(async () => {
      trigger.focus();
      fireEvent.focus(trigger);
      await settleAsyncRender();
    });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "inline",
    );

    await act(async () => {
      fireEvent.click(trigger);
      await settleAsyncRender();
    });

    const headingItem = view.getByRole("menuitem", { name: "Heading 1" });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "blocks",
    );

    await act(async () => {
      headingItem.focus();
      fireEvent.focus(headingItem);
      await settleAsyncRender();
    });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "blocks",
    );
  });

  test("keeps inline presentation while the Color picker owns focus", async () => {
    const { actions, view } = renderTextActionMenu();

    await openColorMenu(view);
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "inline",
    );

    const colorOptions = view.getByRole("menu", { name: "Color options" });
    await act(async () => {
      colorOptions.focus();
      fireEvent.focus(colorOptions);
      await settleAsyncRender();
    });
    expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
      "inline",
    );
  });

  test("invokes supported annotation and Nodex actions", async () => {
    const { actions, view } = renderTextActionMenu();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Bold" }));
      fireEvent.click(view.getByRole("button", { name: "Clear format" }));
      fireEvent.click(view.getByRole("button", { name: "Equation" }));
      await settleAsyncRender();
    });

    expect(actions.styles.join(",")).toBe("bold");
    expect(actions.clearFormat).toBe(1);
    expect(actions.equations).toBe(1);
  });

  function preferredChat() {
    const existingThread = SEND_TO_THREAD_THREADS[0];
    if (!existingThread) throw new Error("missing send-to-thread fixture");
    return {
      kind: "thread" as const,
      thread: makePreferredThreadFromItem(existingThread),
      sessionId: "session-preferred",
      meta: "This chat",
    };
  }

  const renderPicker: NonNullable<NfmTextActionMenuSurfaceProps["renderSendToThreadMenu"]> = (
    props,
  ) => (
    <NfmSendToThreadMenuSurface
      {...props}
      threadItems={SEND_TO_THREAD_THREADS}
      enableThreadSearch={false}
    />
  );

  test("sends the selection to the chat beside the Page in one step", async () => {
    const { actions, view } = renderTextActionMenu({
      chat: { contextualTarget: preferredChat() },
      renderSendToThreadMenu: renderPicker,
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to chat" }));
      await settleAsyncRender();
    });

    await waitFor(() => {
      expect(actions.sendRequests.length).toBe(1);
    });
    expect(actions.sendRequests[0]?.target).toEqual({
      kind: "thread",
      threadId: "thread-existing",
      sessionId: "session-preferred",
    });
    expect(view.queryByRole("dialog", { name: "Send to chat" })).toBe(null);
  });

  test("chooses another chat from the picker beside Send", async () => {
    const { actions, view } = renderTextActionMenu({
      chat: { contextualTarget: preferredChat() },
      renderSendToThreadMenu: renderPicker,
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to another chat" }));
      await settleAsyncRender();
    });

    expect(Boolean(view.getByRole("dialog", { name: "Send to chat" }))).toBe(true);
    expect(Boolean(view.getByRole("combobox", { name: "Search chats" }))).toBe(true);
    expect(view.queryByRole("button", { name: "Send & wrap" })).toBe(null);
    const options = view.getAllByRole("option");
    expect(options[0]?.textContent?.includes("This chat") ?? false).toBe(true);
    expect(options.at(-1)?.textContent?.includes("New chat") ?? false).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: /New chat/ }));
      await settleAsyncRender();
    });

    await waitFor(() => {
      expect(actions.sendRequests.length).toBe(1);
    });
    expect(actions.sendRequests[0]?.target.kind).toBe("new-thread");
    await waitFor(() => {
      expect(view.queryByRole("dialog", { name: "Send to chat" })).toBe(null);
    });
  });

  test("opens the picker from Send when no chat is beside the Page", async () => {
    const { actions, view } = renderTextActionMenu({ renderSendToThreadMenu: renderPicker });

    expect(view.queryByRole("button", { name: "Send to another chat" })).toBe(null);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Send to chat" }));
      await settleAsyncRender();
    });

    expect(Boolean(view.getByRole("dialog", { name: "Send to chat" }))).toBe(true);
    expect(actions.sendRequests.length).toBe(0);
  });

  test("adds the selection to the beside chat's composer only when it has one", async () => {
    const withComposer = renderTextActionMenu({
      chat: {
        contextualTarget: preferredChat(),
        onAddToComposer: () => {
          withComposer.actions.composerAdds += 1;
        },
      },
    });

    await act(async () => {
      fireEvent.click(withComposer.view.getByRole("button", { name: "Add to composer" }));
      await settleAsyncRender();
    });
    expect(withComposer.actions.composerAdds).toBe(1);
    withComposer.view.unmount();

    const withoutComposer = renderTextActionMenu();
    expect(withoutComposer.view.queryByRole("button", { name: "Add to composer" })).toBe(null);
  });

  test("offers no chat actions when the Page cannot send", () => {
    const { view } = renderTextActionMenu({ chat: null });

    expect(view.queryByRole("button", { name: "Send to chat" })).toBe(null);
    expect(Boolean(view.getByRole("button", { name: "Normal Text" }))).toBe(true);
  });
  test("selected-block picker displays the current session hint and keeps New chat at the bottom", async () => {
    const existingThread = SEND_TO_THREAD_THREADS[0];
    if (!existingThread) {
      throw new Error("missing send-to-thread fixture");
    }

    const view = render(
      <NodexTooltipProvider>
        <NfmSendToThreadMenuSurface
          projectId="default"
          threadItems={[
            {
              ...existingThread,
              updatedAt: 1,
            },
            {
              ...existingThread,
              threadId: "thread-newer",
              id: "thread:thread-newer",
              title: "Recently updated",
              updatedAt: 5,
            },
          ]}
          enableThreadSearch={false}
          projectNameById={{ default: "Default" }}
          preferredTarget={{
            kind: "thread",
            thread: makePreferredThreadFromItem(existingThread, { updatedAt: 1 }),
            sessionId: "session-preferred",
            meta: "This chat",
          }}
          onAccept={() => undefined}
          onClose={() => undefined}
        />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();

    const options = view.getAllByRole("option");
    expect(options.length).toBe(3);
    expect(options[0]?.textContent?.includes("Existing implementation") ?? false).toBe(true);
    expect(options[0]?.textContent?.includes("This chat") ?? false).toBe(true);
    expect(options[1]?.textContent?.includes("Recently updated") ?? false).toBe(true);
    expect(options[1]?.textContent?.includes("Default") ?? false).toBe(true);
    expect(options[2]?.textContent?.includes("New chat") ?? false).toBe(true);
  });

  test("selected-block picker shows a compact snippet for content-only chat matches", async () => {
    const existingThread = SEND_TO_THREAD_THREADS[0];
    if (!existingThread) {
      throw new Error("missing send-to-thread fixture");
    }

    const view = render(
      <NodexTooltipProvider>
        <NfmSendToThreadMenuSurface
          projectId="default"
          threadItems={SEND_TO_THREAD_THREADS}
          enableThreadSearch={false}
          initialQuery="handoff"
          threadSearchBatch={{
            query: "handoff",
            loading: false,
            error: null,
            results: [
              {
                thread: {
                  threadId: existingThread.threadId,
                  sessionId: existingThread.sessionId,
                  projectId: existingThread.projectId,
                  projectName: existingThread.projectName,
                  title: existingThread.title,
                  preview: existingThread.preview,
                  cwd: existingThread.cwd,
                  gitBranch: existingThread.gitBranch,
                  projectless: existingThread.projectless,
                  pinned: existingThread.pinned,
                  pinnedOrder: existingThread.pinnedOrder,
                  statusType: existingThread.statusType,
                  statusActiveFlags: existingThread.statusActiveFlags,
                  createdAt: existingThread.createdAt,
                  updatedAt: existingThread.updatedAt,
                },
                snippet: "Review handoff notes before sending.",
              },
            ],
          }}
          onAccept={() => undefined}
          onClose={() => undefined}
        />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();

    const options = view.getAllByRole("option");
    expect(options.length).toBe(2);
    expect(options[0]?.textContent?.includes("Existing implementation") ?? false).toBe(true);
    expect(options[0]?.textContent?.includes("Review handoff notes before sending.") ?? false).toBe(
      true,
    );
    expect(options[1]?.textContent?.includes("New chat") ?? false).toBe(true);
  });

  test("selected-block picker displays current session new chat first when the session has no thread", async () => {
    const existingThread = SEND_TO_THREAD_THREADS[0];
    if (!existingThread) {
      throw new Error("missing send-to-thread fixture");
    }
    const acceptedRequests: string[] = [];

    const view = render(
      <NodexTooltipProvider>
        <NfmSendToThreadMenuSurface
          projectId="default"
          threadItems={[
            {
              ...existingThread,
              threadId: "thread-newer",
              id: "thread:thread-newer",
              title: "Recently updated",
              updatedAt: 5,
            },
          ]}
          enableThreadSearch={false}
          projectNameById={{ default: "Default" }}
          preferredTarget={{
            kind: "new-thread",
            sessionId: "session-current",
            meta: "This chat",
          }}
          onAccept={(request) => {
            acceptedRequests.push(JSON.stringify(request.target));
          }}
          onClose={() => undefined}
        />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();

    const options = view.getAllByRole("option");
    expect(options.length).toBe(2);
    expect(options[0]?.textContent?.includes("New chat") ?? false).toBe(true);
    expect(options[0]?.textContent?.includes("This chat") ?? false).toBe(true);
    expect(options[1]?.textContent?.includes("Recently updated") ?? false).toBe(true);

    await act(async () => {
      fireEvent.click(options[0] as HTMLElement);
      await settleAsyncRender();
    });
    expect(acceptedRequests.join(",")).toBe('{"kind":"new-thread","sessionId":"session-current"}');
  });

  test("Send to chat can use the current Session new chat target", async () => {
    const existingThread = SEND_TO_THREAD_THREADS[0];
    if (!existingThread) {
      throw new Error("missing send-to-thread fixture");
    }

    const view = render(
      <NodexTooltipProvider>
        <NfmSendToThreadMenuSurface
          projectId="default"
          threadItems={[
            {
              ...existingThread,
              threadId: "thread-session-other",
              id: "thread:thread-session-other",
              title: "Other session",
              updatedAt: 10,
            },
          ]}
          enableThreadSearch={false}
          projectNameById={{ default: "Default" }}
          preferredTarget={{
            kind: "new-thread",
            sessionId: "session-current",
            meta: "This chat",
          }}
          onAccept={() => undefined}
          onClose={() => undefined}
        />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();

    const options = view.getAllByRole("option");
    expect(options.length).toBe(2);
    expect(options[0]?.textContent?.includes("New chat") ?? false).toBe(true);
    expect(options[0]?.textContent?.includes("This chat") ?? false).toBe(true);
    expect(options[1]?.textContent?.includes("Other session") ?? false).toBe(true);
  });

  test("keeps New chat available at the bottom for empty search results", async () => {
    const view = render(
      <NodexTooltipProvider>
        <NfmSendToThreadMenuSurface
          projectId="default"
          threadItems={SEND_TO_THREAD_THREADS}
          enableThreadSearch={false}
          initialQuery="nothing matches"
          onAccept={() => undefined}
          onClose={() => undefined}
        />
      </NodexTooltipProvider>,
    );
    await settleAsyncRender();

    expect(Boolean(view.getByText("No matching chats"))).toBe(true);
    const options = view.getAllByRole("option");
    expect(options.length).toBe(1);
    expect(options[0]?.textContent?.includes("New chat") ?? false).toBe(true);
  });

  test("hands More off to block actions without opening the legacy dropdown", async () => {
    const { actions, view } = renderTextActionMenu();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "More" }));
      await settleAsyncRender();
    });

    expect(actions.blockActions).toBe(1);
    expect(view.queryByRole("menuitem", { name: "Block actions" }) === null).toBe(true);
    expect(view.queryByRole("menuitem", { name: "Duplicate" }) === null).toBe(true);
  });

  test("opens the send-to-chat picker only after activation", async () => {
    const focusProbe = installFocusProbe();
    try {
      const { view } = renderTextActionMenu({
        renderSendToThreadMenu: (props) => (
          <NfmSendToThreadMenuSurface
            {...props}
            threadItems={SEND_TO_THREAD_THREADS}
            enableThreadSearch={false}
          />
        ),
      });

      await act(async () => {
        fireEvent.pointerEnter(view.getByRole("button", { name: "Send to chat" }));
        await settleAsyncRender();
      });

      expect(view.queryByRole("dialog", { name: "Send to chat" }) === null).toBe(true);
      expect(document.activeElement === focusProbe).toBe(true);

      const sendToChatRow = view.getByRole("button", { name: "Send to chat" });
      await act(async () => {
        sendToChatRow.focus();
        fireEvent.focus(sendToChatRow);
        await settleAsyncRender();
      });

      expect(view.queryByRole("dialog", { name: "Send to chat" }) === null).toBe(true);

      await act(async () => {
        fireEvent.click(sendToChatRow);
        await settleAsyncRender();
      });

      const searchInput = view.getByRole("combobox", { name: "Search chats" });
      expect(Boolean(view.getByRole("dialog", { name: "Send to chat" }))).toBe(true);
      expect(document.activeElement === sendToChatRow).toBe(true);
      expect(document.activeElement === searchInput).toBe(false);
    } finally {
      focusProbe.remove();
    }
  });

  test("reports Block presentation while a Block action picker is active", async () => {
    const focusProbe = installFocusProbe();
    try {
      const { actions, view } = renderTextActionMenu({
        renderSendToThreadMenu: (props) => (
          <NfmSendToThreadMenuSurface
            {...props}
            threadItems={SEND_TO_THREAD_THREADS}
            enableThreadSearch={false}
          />
        ),
      });

      const sendToChatRow = view.getByRole("button", { name: "Send to chat" });
      await act(async () => {
        sendToChatRow.focus();
        fireEvent.focus(sendToChatRow);
        await settleAsyncRender();
      });
      expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
        "inline",
      );

      await act(async () => {
        fireEvent.click(sendToChatRow);
        expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
          "blocks",
        );
        await settleAsyncRender();
      });

      expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
        "blocks",
      );

      const searchInput = view.getByRole("combobox", { name: "Search chats" });
      await act(async () => {
        searchInput.focus();
        fireEvent.focus(searchInput);
        await settleAsyncRender();
      });
      expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
        "blocks",
      );

      await act(async () => {
        fireEvent.keyDown(searchInput, { key: "Escape" });
        await settleAsyncRender();
      });

      expect(view.queryByRole("dialog", { name: "Send to chat" }) === null).toBe(true);

      await act(async () => {
        view.unmount();
        await settleAsyncRender();
      });

      await waitFor(() => {
        expect(actions.selectionPresentations[actions.selectionPresentations.length - 1]).toBe(
          "none",
        );
      });
    } finally {
      focusProbe.remove();
    }
  });

  test("shows hover tooltips for icon-only formatting buttons", async () => {
    const { view } = renderTextActionMenu();

    await act(async () => {
      const italic = view.getByRole("button", { name: "Italic" });
      fireEvent.pointerEnter(italic, { pointerType: "mouse" });
      fireEvent.mouseEnter(italic);
      await settleAsyncRender();
    });

    expect(view.getAllByText("Italic").length > 0).toBe(true);
  });

  test("renders the color trigger as a DOM A over the selected background", () => {
    const { view } = renderTextActionMenu({
      textColor: "blue",
      backgroundColor: "yellow",
    });

    const colorButton = view.getByRole("button", { name: "Color" });

    expect(colorButton.textContent).toBe("A");
    expect(colorButton.querySelector("svg") === null).toBe(true);
  });

  test("opens the Notion-style color grid in fixture order", async () => {
    const { view } = renderTextActionMenu();

    await openColorMenu(view);

    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);
    expect(Boolean(view.getByText("Recently used"))).toBe(true);
    expect(Boolean(view.getByText("Text color"))).toBe(true);
    expect(Boolean(view.getByText("Background color"))).toBe(true);

    const itemLabels = view
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("aria-label"))
      .join("|");

    expect(itemLabels).toBe(
      "Recently used: Yellow background" +
        "|Text color: Default|Text color: Gray|Text color: Brown|Text color: Orange|Text color: Yellow|Text color: Green|Text color: Blue|Text color: Purple|Text color: Pink|Text color: Red" +
        "|Background color: Default|Background color: Gray|Background color: Brown|Background color: Orange|Background color: Yellow|Background color: Green|Background color: Blue|Background color: Purple|Background color: Pink|Background color: Red",
    );
  });

  test("renders five persisted recently-used color slots before the color grids", async () => {
    writeTextActionRecentColors([
      { kind: "text", color: "blue" },
      { kind: "text", color: "pink" },
      { kind: "background", color: "red" },
      { kind: "background", color: "purple" },
      { kind: "background", color: "green" },
    ]);
    const { view } = renderTextActionMenu();

    await openColorMenu(view);

    const firstSixItemLabels = view
      .getAllByRole("menuitem")
      .slice(0, 6)
      .map((item) => item.getAttribute("aria-label"))
      .join("|");

    expect(firstSixItemLabels).toBe(
      "Recently used: Blue text" +
        "|Recently used: Pink text" +
        "|Recently used: Red background" +
        "|Recently used: Purple background" +
        "|Recently used: Green background" +
        "|Text color: Default",
    );
  });

  test("delegates color swatches and reuses the persisted recent color", async () => {
    const { actions, view } = renderTextActionMenu();

    await openColorMenu(view);
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Text color: Blue" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.join(",")).toBe("blue");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Recently used: Blue text" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.join(",")).toBe("blue,blue");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Background color: Yellow" }));
      await settleAsyncRender();
    });

    expect(actions.backgroundColors.join(",")).toBe("yellow");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);
  });

  test("toggles the active text and background colors back to default without closing", async () => {
    const { actions, view } = renderTextActionMenu({
      textColor: "blue",
      backgroundColor: "yellow",
    });

    await openColorMenu(view);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Text color: Blue" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.join(",")).toBe("default");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Background color: Yellow" }));
      await settleAsyncRender();
    });

    expect(actions.backgroundColors.join(",")).toBe("default");
    expect(Boolean(view.getByRole("dialog", { name: "Color" }))).toBe(true);
  });

  test("keeps unsupported color controls inert", async () => {
    writeTextActionRecentColors([{ kind: "text", color: "blue" }]);
    const { actions, view } = renderTextActionMenu({
      canUseTextColor: false,
      canUseBackgroundColor: true,
    });

    await openColorMenu(view);

    expect(view.queryByText("Text color") === null).toBe(true);
    expect(
      view
        .getByRole("menuitem", { name: "Recently used: Blue text" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Recently used: Blue text" }));
      await settleAsyncRender();
    });

    expect(actions.textColors.length).toBe(0);
    expect(actions.backgroundColors.length).toBe(0);
  });

  test("disables the color trigger when no color style is supported", async () => {
    const { view } = renderTextActionMenu({
      canUseTextColor: false,
      canUseBackgroundColor: false,
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Color" }));
      await settleAsyncRender();
    });

    expect(view.getByRole("button", { name: "Color" }).getAttribute("aria-disabled")).toBe("true");
    expect(view.queryByRole("dialog", { name: "Color" }) === null).toBe(true);
  });
});
