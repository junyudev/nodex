import { act, render } from "@testing-library/react";
import { createElement, useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  dispatchFocusedHistory,
  readFocusedHistory,
  registerFocusedHistory,
  retainPendingHistoryInput,
} from "./focused-history";
import { createSurfaceHistory } from "./surface-history/owner";
import { ComposerPromptEditor } from "@/features/local-conversation/view/composer/composer-prompt-editor";

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
