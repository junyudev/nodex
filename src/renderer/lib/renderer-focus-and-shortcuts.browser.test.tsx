import { expect, test, describe, vi } from "vite-plus/test";
import {
  captureCommandPaletteFocus,
  readCommandPaletteSelectionQuery,
} from "./command-palette-focus";
import { act, render, fireEvent } from "@testing-library/react";
import { createElement, useState } from "react";
import { userEvent } from "vite-plus/test/browser";
import {
  dispatchFocusedHistory,
  readFocusedHistory,
  registerFocusedHistory,
  retainPendingHistoryInput,
} from "./focused-history";
import { createSurfaceHistory } from "./surface-history/owner";
import { ComposerPromptEditor } from "@/features/local-conversation/view/composer/composer-prompt-editor";
import { KeyboardShortcutHelpDialog } from "@/components/workbench/keyboard-shortcut-help-dialog";
import { isComposerDictationShortcut } from "@/features/local-conversation/view/composer/use-composer-dictation";
import {
  createCommandKeymapState,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import { useWorkbenchShortcuts, type WorkbenchShortcutActions } from "./use-workbench-shortcuts";
import "../globals.css";

describe("command palette focus", () => {
  test("restores the editor's directional selection without scrolling its owner", () => {
    const scroller = document.createElement("div");
    scroller.style.cssText = "height: 100px; overflow: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "500px";
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const start = document.createTextNode("First paragraph");
    const end = document.createTextNode("Second paragraph");
    editor.append(start, document.createElement("br"), end);
    scroller.append(spacer, editor);
    const search = document.createElement("input");
    document.body.append(scroller, search);
    editor.focus();
    const selection = document.getSelection();
    if (!selection) throw new Error("Expected Chromium document selection");
    selection.setBaseAndExtent(end, 6, start, 2);
    const snapshot = captureCommandPaletteFocus();
    search.focus();
    selection.removeAllRanges();
    scroller.scrollTop = 0;

    snapshot.restore();

    expect(document.activeElement).toBe(editor);
    expect(scroller.scrollTop).toBe(0);
    expect(selection.anchorNode).toBe(end);
    expect(selection.anchorOffset).toBe(6);
    expect(selection.focusNode).toBe(start);
    expect(selection.focusOffset).toBe(2);
  });

  test("restores the deepest shadow input and its native selection", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    outer.attachShadow({ mode: "open" }).append(inner);
    const input = document.createElement("input");
    input.value = "Search this phrase";
    inner.attachShadow({ mode: "open" }).append(input);
    const search = document.createElement("input");
    document.body.append(outer, search);
    input.focus();
    input.setSelectionRange(2, 9, "backward");
    const snapshot = captureCommandPaletteFocus();
    expect(snapshot.originElement).toBe(input);
    search.focus();
    input.setSelectionRange(0, 0);

    snapshot.restore();

    expect(document.activeElement).toBe(outer);
    expect(inner.shadowRoot?.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(9);
    expect(input.selectionDirection).toBe("backward");
  });

  test("restores the directional selection inside a shadow editor", () => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" }) as ShadowRoot & {
      getSelection: () => Selection | null;
    };
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const text = document.createTextNode("An embedded editor");
    editor.append(text);
    root.append(editor);
    const search = document.createElement("input");
    document.body.append(host, search);
    editor.focus();
    const selection = root.getSelection();
    if (!selection) throw new Error("Expected Chromium shadow selection");
    selection.setBaseAndExtent(text, 15, text, 3);
    expect(readCommandPaletteSelectionQuery()).toBe("embedded edi");
    const snapshot = captureCommandPaletteFocus();
    search.focus();
    selection.removeAllRanges();

    snapshot.restore();

    expect(root.activeElement).toBe(editor);
    expect(selection.anchorNode).toBe(text);
    expect(selection.anchorOffset).toBe(15);
    expect(selection.focusNode).toBe(text);
    expect(selection.focusOffset).toBe(3);
  });

  test("seeds only a bounded single-line selection and never reads password contents", () => {
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    const select = (text: string) => {
      input.value = text;
      input.select();
      return readCommandPaletteSelectionQuery();
    };
    expect(select("  chosen phrase  ")).toBe("chosen phrase");
    expect(select("x".repeat(256))).toHaveLength(256);
    expect(select("x".repeat(257))).toBeUndefined();
    expect(select("first\nsecond")).toBeUndefined();
    expect(select("first\0second")).toBeUndefined();
    expect(select(" \t ")).toBeUndefined();
    const password = document.createElement("input");
    password.type = "password";
    password.value = "private";
    document.body.append(password);
    password.focus();
    password.select();
    expect(readCommandPaletteSelectionQuery()).toBeUndefined();
  });

  test("leaves replacement surfaces alone after the original focus owner is removed", () => {
    const origin = document.createElement("button");
    const replacement = document.createElement("input");
    document.body.append(origin, replacement);
    origin.focus();
    const snapshot = captureCommandPaletteFocus();
    origin.remove();
    replacement.focus();

    snapshot.restore();

    expect(document.activeElement).toBe(replacement);
  });

  test("restores focus without reviving detached or shortened selection endpoints", () => {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const text = document.createTextNode("Original paragraph");
    editor.append(text);
    const search = document.createElement("input");
    document.body.append(editor, search);
    editor.focus();
    document.getSelection()?.setBaseAndExtent(text, 3, text, 14);
    const snapshot = captureCommandPaletteFocus();
    search.focus();
    text.data = "New";

    expect(() => snapshot.restore()).not.toThrow();
    expect(document.activeElement).toBe(editor);
    search.focus();
    text.remove();
    expect(() => snapshot.restore()).not.toThrow();
    expect(document.activeElement).toBe(editor);
  });
});

describe("focused history", () => {
  function Prompt() {
    const [value, setValue] = useState("");
    return createElement(ComposerPromptEditor, {
      value,
      placeholder: "Prompt",
      disabled: false,
      onChange: setValue,
      onKeyDown: () => false,
    });
  }

  const history = () =>
    createSurfaceHistory({
      scopeKey: "test",
      adapter: {
        describe: () => "Edit",
        prepare: async () => ({ kind: "complete", receipt: "noop" }),
        prepareInverse: async () => ({ kind: "complete", receipt: "noop" }),
        submit: async () => ({ kind: "committed", receipt: "noop" }),
        interpret: () => ({ kind: "noop" }),
      },
    });

  test("capabilities follow the nearest surface without claiming embedded or native input history", async () => {
    const editorHistory = history();
    const viewHistory = history();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.tabIndex = 0;
    const view = document.createElement("section");
    view.contentEditable = "false";
    const row = document.createElement("button");
    row.textContent = "Page";
    const input = document.createElement("input");
    view.append(row, input);
    editor.append(view);
    document.body.append(editor);
    const releaseEditor = registerFocusedHistory(editor, {
      controls: editorHistory,
      contentEditableRoot: () => editor,
    });
    const releaseView = registerFocusedHistory(view, { controls: viewHistory });
    try {
      await act(async () => {
        editor.focus();
        await Promise.resolve();
      });
      expect(readFocusedHistory()?.ownerId).toBe(editorHistory.snapshot().ownerId);
      await act(async () => {
        row.focus();
        await Promise.resolve();
      });
      expect(readFocusedHistory()?.ownerId).toBe(viewHistory.snapshot().ownerId);
      await act(async () => {
        input.focus();
        await Promise.resolve();
      });
      expect(readFocusedHistory()).toBeNull();
      releaseView();
      await act(async () => {
        row.focus();
        await Promise.resolve();
      });
      expect(readFocusedHistory()).toBeNull();
    } finally {
      releaseView();
      releaseEditor();
      editorHistory.close();
      viewHistory.close();
      editor.remove();
    }
  });

  test("history shortcuts on nested controls use the nearest registered surface owner", () => {
    const editorHistory = history();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const boundary = document.createElement("section");
    boundary.setAttribute("data-embedded-surface-input", "page-title");
    const expand = document.createElement("button");
    boundary.append(expand);
    editor.append(boundary);
    document.body.append(editor);
    const request = vi.fn(editorHistory.request);
    const release = registerFocusedHistory(editor, {
      controls: { ...editorHistory, request },
      contentEditableRoot: () => editor,
    });
    try {
      expand.focus();
      const undo = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(expand.dispatchEvent(undo)).toBe(false);
      expect(request).toHaveBeenCalledExactlyOnceWith("undo");

      dispatchFocusedHistory("redo");
      expect(request).toHaveBeenLastCalledWith("redo");
    } finally {
      release();
      editorHistory.close();
      editor.remove();
    }
  });

  test("menu history follows the Composer focus, not the previously active Page", async () => {
    const page = document.createElement("div");
    page.className = "nfm-editor";
    page.tabIndex = 0;
    document.body.append(page);
    const pageHistory = vi.fn();
    page.addEventListener("beforeinput", pageHistory, true);
    page.focus();
    const view = render(createElement(Prompt));
    const composer = view.container.querySelector<HTMLElement>("[contenteditable=true]")!;
    const composerHistory = vi.fn();
    composer.addEventListener("beforeinput", (event) => {
      if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
      composerHistory(event.inputType);
      // This checks routing ownership, independently of Composer's editing engine.
      event.preventDefault();
    });
    try {
      await act(async () => {
        composer.focus();
        dispatchFocusedHistory("undo");
        dispatchFocusedHistory("redo");
        await Promise.resolve();
      });
      expect(composerHistory.mock.calls).toEqual([["historyUndo"], ["historyRedo"]]);
      expect(pageHistory).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      page.remove();
    }
  });

  test("native menu intents preserve ordinary input undo and redo", async () => {
    const input = document.createElement("input");
    document.body.append(input);
    try {
      await act(async () => {
        input.focus();
        await userEvent.keyboard("native text");
      });
      expect(input.value).toBe("native text");
      await act(async () => {
        dispatchFocusedHistory("undo");
        await Promise.resolve();
      });
      expect(input.value).toBe("");
      await act(async () => {
        dispatchFocusedHistory("redo");
        await Promise.resolve();
      });
      expect(input.value).toBe("native text");
    } finally {
      input.remove();
    }
  });

  test.each(["pointer", "focus", "nested input", "typing", "window", "detach"] as const)(
    "pending history gives up input after %s changes the target",
    async (interaction) => {
      const controls = history();
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      const other = document.createElement("input");
      document.body.append(editor, other);
      const request = vi.fn();
      editor.focus();
      const previous = retainPendingHistoryInput(editor, controls, request);
      const pending = retainPendingHistoryInput(editor, controls, request);
      try {
        await act(async () => {
          editor.blur();
          previous.release();
          expect(readFocusedHistory()?.ownerId).toBe(controls.snapshot().ownerId);
          dispatchFocusedHistory("undo");
        });
        expect(request.mock.calls).toEqual([["undo"]]);
        await act(async () => {
          if (interaction === "pointer")
            document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          if (interaction === "focus") {
            other.focus();
            other.blur();
          }
          if (interaction === "nested input") {
            editor.append(other);
            other.focus();
            other.blur();
          }
          if (interaction === "typing") await userEvent.keyboard("x");
          if (interaction === "window") window.dispatchEvent(new Event("blur"));
          if (interaction === "detach") editor.remove();
          await Promise.resolve();
        });
        expect(pending.isCurrent()).toBe(false);
        expect(readFocusedHistory()).toBeNull();
        await act(async () => {
          dispatchFocusedHistory("redo");
          await Promise.resolve();
        });
        expect(request.mock.calls).toEqual([["undo"]]);
      } finally {
        pending.release();
        previous.release();
        controls.close();
        editor.remove();
        other.remove();
      }
    },
  );
});

describe("renderer command keymap", () => {
  test("pending shortcut help mounts without Node globals and adopts the loaded keymap", async () => {
    expect(typeof process).toBe("undefined");
    const props = { open: true, onOpenChange: vi.fn(), onCustomize: vi.fn() };
    const view = render(<KeyboardShortcutHelpDialog {...props} commandKeymapState={null} />);
    await view.findByRole("dialog", { name: "Keyboard shortcuts" });
    const search = view.getByRole("textbox", { name: "Search keyboard shortcuts" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "Open settings" } });
    });
    expect(view.getByText("Settings")).toBeVisible();
    view.rerender(
      <KeyboardShortcutHelpDialog
        {...props}
        commandKeymapState={createCommandKeymapState({ settings: ["Ctrl+Alt+Y"] }, "linux")}
      />,
    );
    expect(await view.findByText("Ctrl+Alt+Y")).toBeVisible();
    expect(view.getByRole("textbox", { name: "Search keyboard shortcuts" })).toBe(search);
  });

  function MouseBindings({
    state,
    back,
    forward,
  }: {
    readonly state: CommandKeymapState | null;
    readonly back: NonNullable<WorkbenchShortcutActions["navigateBack"]>;
    readonly forward: NonNullable<WorkbenchShortcutActions["navigateForward"]>;
  }) {
    useWorkbenchShortcuts({
      projectOrder: [],
      switchToProjectIndex: () => {},
      commandKeymapState: state,
      navigateBack: back,
      navigateForward: forward,
    });
    return null;
  }

  test("pending mouse navigation uses browser-safe defaults until loaded bindings take ownership", async () => {
    expect(typeof process).toBe("undefined");
    const back = vi.fn();
    const forward = vi.fn();
    const view = render(<MouseBindings state={null} back={back} forward={forward} />);
    const dispatch = async (button: number) => {
      const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
      await act(async () => {
        document.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(await dispatch(3)).toBe(true);
    expect(back).toHaveBeenCalledExactlyOnceWith("mouse_back");
    expect(await dispatch(4)).toBe(true);
    expect(forward).toHaveBeenCalledExactlyOnceWith("mouse_forward");
    view.rerender(
      <MouseBindings
        state={createCommandKeymapState({ navigateBack: [], navigateForward: [] }, "linux")}
        back={back}
        forward={forward}
      />,
    );
    expect(await dispatch(3)).toBe(false);
    expect(await dispatch(4)).toBe(false);
    view.unmount();
    expect(await dispatch(3)).toBe(false);
    expect(back).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
  });

  test("pending composer shortcut recognition is browser-safe without acquiring microphone authority", () => {
    expect(typeof process).toBe("undefined");
    const event = new KeyboardEvent("keydown", { key: "m", ctrlKey: true });
    expect(isComposerDictationShortcut(event, undefined)).toBe(true);
    const loaded = createCommandKeymapState({ composerDictationHold: [] }, "linux");
    expect(isComposerDictationShortcut(event, loaded)).toBe(false);
  });
});
