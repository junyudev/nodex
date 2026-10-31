import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import {
  createCommandKeymapState,
  type CommandKeymapState,
} from "../../../../shared/command-keybindings";
import { queryKeys } from "@/lib/query-keys";
import { useCommandShortcutLabel } from "@/lib/use-command-keymap-state";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { NfmChatSendShortcutController } from "./nfm-chat-send-shortcut-controller";
import {
  NfmTextActionMenuRuntimeProvider,
  type NfmTextActionMenuChatRuntime,
} from "./nfm-text-action-menu-runtime";
import { NfmPromptRuntimeProvider } from "./nfm-prompt-runtime";

const harness = vi.hoisted(() => ({
  editor: {
    domElement: null as HTMLElement | null,
    getSelection: vi.fn<() => { blocks: { id: string }[] } | undefined>(),
    getTextCursorPosition: () => ({ block: { id: "child" } }),
    getBlock: () => ({ id: "child", type: "paragraph" }),
    getParentBlock: (id: string) => (id === "child" ? { id: "prompt", type: "prompt" } : undefined),
  },
  sideMenu: { openForCurrentSelection: vi.fn() },
}));
vi.mock("@blocknote/react", () => ({ useBlockNoteEditor: () => harness.editor }));
vi.mock("./nfm-side-menu", () => ({ useNfmSideMenuOpenController: () => harness.sideMenu }));

beforeEach(() => {
  vi.clearAllMocks();
  harness.editor.getSelection.mockReturnValue({ blocks: [{ id: "selected" }] });
});

function mount(state: CommandKeymapState, contextual = true) {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.settings.commandKeymap(), state);
  const chat: NfmTextActionMenuChatRuntime = {
    projectId: "project",
    contextualTarget: contextual
      ? { kind: "new-thread", sessionId: "session", meta: "This chat" }
      : null,
    send: vi.fn(),
    addToComposer: vi.fn(),
  };
  const sendPrompt = vi.fn(async () => {});
  const view = render(
    <TestQueryProvider client={client}>
      <ShortcutLabels />
      <div
        ref={(node) => {
          harness.editor.domElement = node;
        }}
      >
        <div data-testid="editor-target" contentEditable suppressContentEditableWarning />
        <NfmTextActionMenuRuntimeProvider value={{ chat }}>
          <NfmPromptRuntimeProvider
            value={{
              destination: { kind: "beside", sessionId: "session-1", title: "Current chat" },
              send: sendPrompt,
            }}
          >
            <NfmChatSendShortcutController />
          </NfmPromptRuntimeProvider>
        </NfmTextActionMenuRuntimeProvider>
      </div>
      <input aria-label="Outside editor" />
    </TestQueryProvider>,
  );
  const dispatch = async (init: KeyboardEventInit, target = view.getByTestId("editor-target")) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    await act(async () => {
      fireEvent(target, event);
      await Promise.resolve();
    });
    return event.defaultPrevented;
  };
  return { ...view, client, chat, dispatch, sendPrompt };
}

function ShortcutLabels() {
  const send = useCommandShortcutLabel("pageEditorSendToChat");
  const add = useCommandShortcutLabel("pageEditorAddToComposer");
  return (
    <>
      <output aria-label="Send shortcut">{send}</output>
      <output aria-label="Add shortcut">{add}</output>
    </>
  );
}

test("controller adopts live overrides for both actions and keeps them inside its editor", async () => {
  const view = mount(createCommandKeymapState({}, "linux"));
  expect(await view.dispatch({ key: "Enter", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(view.chat.send).toHaveBeenCalledExactlyOnceWith(
    { target: { kind: "new-thread", sessionId: "session" } },
    ["selected"],
  );
  await act(async () => {
    view.client.setQueryData(
      queryKeys.settings.commandKeymap(),
      createCommandKeymapState(
        {
          pageEditorSendToChat: ["Ctrl+Alt+Y"],
          pageEditorAddToComposer: ["Ctrl+Shift+U"],
        },
        "linux",
      ),
    );
    await Promise.resolve();
  });
  await view.findByText("Ctrl+Alt+Y");
  expect(view.getByLabelText("Add shortcut").textContent).toBe("Ctrl+Shift+U");
  expect(await view.dispatch({ key: "y", ctrlKey: true, altKey: true })).toBe(true);
  expect(await view.dispatch({ key: "Enter", ctrlKey: true, shiftKey: true })).toBe(false);
  expect(await view.dispatch({ key: "u", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(view.chat.addToComposer).toHaveBeenCalledExactlyOnceWith(["selected"]);
  expect(await view.dispatch({ key: "y", ctrlKey: true, altKey: true, isComposing: true })).toBe(
    false,
  );
  expect(
    await view.dispatch({ key: "y", ctrlKey: true, altKey: true }, view.getByRole("textbox")),
  ).toBe(false);
  const calls = vi.mocked(view.chat.send).mock.calls.length;
  view.unmount();
  expect(await view.dispatch({ key: "y", ctrlKey: true, altKey: true }, document.body)).toBe(false);
  expect(view.chat.send).toHaveBeenCalledTimes(calls);
});

test.each(["macOS", "windows", "linux"] as const)(
  "%s labels use platform defaults and clear when unassigned",
  async (platform) => {
    const view = mount(createCommandKeymapState({}, platform));
    expect(view.getByLabelText("Send shortcut").textContent).toBe(
      platform === "macOS" ? "⇧⌘⏎" : "Ctrl+Shift+Enter",
    );
    expect(view.getByLabelText("Add shortcut").textContent).toBe(
      platform === "macOS" ? "⌥⌘⏎" : "Ctrl+Alt+Enter",
    );
    await act(async () => {
      view.client.setQueryData(
        queryKeys.settings.commandKeymap(),
        createCommandKeymapState(
          {
            pageEditorSendToChat: [],
            pageEditorAddToComposer: [],
          },
          platform,
        ),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByLabelText("Send shortcut").textContent).toBe(""));
    expect(view.getByLabelText("Add shortcut").textContent).toBe("");
    expect(
      await view.dispatch({
        key: "Enter",
        shiftKey: true,
        ...(platform === "macOS" ? { metaKey: true } : { ctrlKey: true }),
      }),
    ).toBe(false);
  },
);

test("Send without a beside chat opens the Block picker for the selected Blocks", async () => {
  const view = mount(createCommandKeymapState({}, "macOS"), false);
  expect(await view.dispatch({ key: "Enter", metaKey: true, shiftKey: true })).toBe(true);
  expect(harness.sideMenu.openForCurrentSelection).toHaveBeenCalledExactlyOnceWith({
    returnFocusElement: harness.editor.domElement,
    initialSubmenu: "send-to-thread",
  });
  expect(view.chat.send).not.toHaveBeenCalled();
});

test("a bare caret sends its containing Prompt and never adds it to the Composer", async () => {
  harness.editor.getSelection.mockReturnValue(undefined);
  const view = mount(createCommandKeymapState({}, "macOS"));
  expect(await view.dispatch({ key: "Enter", metaKey: true, altKey: true })).toBe(false);
  expect(await view.dispatch({ key: "Enter", metaKey: true, shiftKey: true })).toBe(true);
  expect(view.sendPrompt).toHaveBeenCalledExactlyOnceWith("prompt");
  expect(view.chat.send).not.toHaveBeenCalled();
  expect(view.chat.addToComposer).not.toHaveBeenCalled();
});
