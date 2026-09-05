import { act, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  buildPromptDoc,
  classifyComposerPaste,
  ComposerPromptEditor,
  measureComposerPromptIntrinsicWidth,
  promptTextOffsetToDocPosition,
  type ComposerPromptEditorHandle,
} from "./composer-prompt-editor";

function renderPromptEditor({
  value,
  singleLine = false,
  allowSlashCommands = true,
  onKeyDown = vi.fn(() => false),
  onLargeTextPaste,
  onPasteFiles,
  onSuggestionStateChange,
  onSuggestionAction,
}: {
  value: string;
  singleLine?: boolean;
  allowSlashCommands?: boolean;
  onKeyDown?: (event: KeyboardEvent) => boolean;
  onLargeTextPaste?: (text: string) => boolean;
  onPasteFiles?: Parameters<typeof ComposerPromptEditor>[0]["onPasteFiles"];
  onSuggestionStateChange?: Parameters<typeof ComposerPromptEditor>[0]["onSuggestionStateChange"];
  onSuggestionAction?: Parameters<typeof ComposerPromptEditor>[0]["onSuggestionAction"];
}) {
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const onChange = vi.fn();
  const view = render(
    <ComposerPromptEditor
      ref={editorRef}
      value={value}
      placeholder="Ask Codex"
      disabled={false}
      singleLine={singleLine}
      allowSlashCommands={allowSlashCommands}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onLargeTextPaste={onLargeTextPaste}
      onPasteFiles={onPasteFiles}
      onSuggestionStateChange={onSuggestionStateChange}
      onSuggestionAction={onSuggestionAction}
    />,
  );
  const editor = view.container.querySelector("[contenteditable='true']");
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Composer editor was not mounted");
  }

  return {
    editor,
    editorRef,
    onChange,
    onKeyDown,
  };
}

function createFileClipboardData(files: readonly File[], initial: Record<string, string> = {}) {
  const { clipboardData, data } = createClipboardData(initial);
  return {
    data,
    clipboardData: {
      ...clipboardData,
      files,
      items: files.map((file) => ({
        kind: "file" as const,
        type: file.type,
        getAsFile: () => file,
      })),
    },
  };
}

function createClipboardData(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    clipboardData: {
      clearData: vi.fn(() => data.clear()),
      getData: vi.fn((format: string) => data.get(format) ?? ""),
      setData: vi.fn((format: string, value: string) => {
        data.set(format, value);
      }),
    },
  };
}

describe("ComposerPromptEditor", () => {
  test("measures the longest unwrapped prompt width without mutating editor styles", () => {
    const editor = document.createElement("div");
    editor.textContent = "A prompt that may wrap";
    editor.style.minHeight = "1.25rem";
    const measurement = vi.spyOn(editor, "getBoundingClientRect").mockImplementation(() => {
      expect(editor.style.position).toBe("fixed");
      expect(editor.style.visibility).toBe("hidden");
      expect(editor.style.width).toBe("max-content");
      return new DOMRect(0, 0, 428, 20);
    });

    expect(measureComposerPromptIntrinsicWidth(editor)).toBe(428);
    expect(editor.getAttribute("style")).toBe("min-height: 1.25rem;");
    expect(measurement).toHaveBeenCalledOnce();
  });

  test("keeps the compact editor in the keyboard tab order", () => {
    const { editor } = renderPromptEditor({
      value: "",
      singleLine: true,
    });

    expect(editor.getAttribute("tabindex")).not.toBe("-1");
  });

  test("classifies the inclusive large-paste boundary", () => {
    expect(classifyComposerPaste("x".repeat(4_999))).toBe("inline");
    expect(classifyComposerPaste("x".repeat(5_000))).toBe("attachment");
  });

  test("hands an accepted large plain-text paste to its attachment owner", () => {
    const onLargeTextPaste = vi.fn(() => true);
    const { editor, editorRef, onChange } = renderPromptEditor({
      value: "existing",
      onLargeTextPaste,
    });
    const text = "x".repeat(5_000);
    const { clipboardData } = createClipboardData({ "text/plain": text });

    act(() => editorRef.current?.focusAtEnd());
    fireEvent.paste(editor, { clipboardData });

    expect(onLargeTextPaste).toHaveBeenCalledWith(text);
    expect(editorRef.current?.getText()).toBe("existing");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("preserves ordinary paste when the attachment owner rejects it", () => {
    const onLargeTextPaste = vi.fn(() => false);
    const { editor, editorRef } = renderPromptEditor({ value: "", onLargeTextPaste });
    const text = "x".repeat(5_000);
    const { clipboardData } = createClipboardData({ "text/plain": text });

    act(() => editorRef.current?.focusAtEnd());
    fireEvent.paste(editor, { clipboardData });

    expect(editorRef.current?.getText()).toBe(text);
  });

  test("hands a pasted image to the attachment owner instead of inserting clipboard text", () => {
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const onPasteFiles = vi.fn(() => true);
    const { editor, editorRef, onChange } = renderPromptEditor({
      value: "existing",
      onPasteFiles,
    });
    const { clipboardData } = createFileClipboardData([image], {
      "text/plain": "diagram.png",
    });

    act(() => editorRef.current?.focusAtEnd());
    fireEvent.paste(editor, { clipboardData });

    expect(onPasteFiles).toHaveBeenCalledWith({
      imageFiles: [image],
      otherFiles: [],
      source: "paste",
    });
    expect(editorRef.current?.getText()).toBe("existing");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("preserves meaningful text when an image shares a rich clipboard payload", () => {
    const image = new File(["image"], "diagram.png", { type: "image/png" });
    const onPasteFiles = vi.fn(() => true);
    const { editor, editorRef } = renderPromptEditor({
      value: "",
      onPasteFiles,
    });
    const { clipboardData } = createFileClipboardData([image], {
      "text/plain": "Keep this note",
      "text/html": '<p>Keep this note</p><img src="data:image/png;base64,aQ==">',
    });

    act(() => editorRef.current?.focusAtEnd());
    fireEvent.paste(editor, { clipboardData });

    expect(onPasteFiles).not.toHaveBeenCalled();
    expect(editorRef.current?.getText()).toBe("Keep this note");
  });

  test("maps text offsets through paragraphs in one traversal", () => {
    const doc = buildPromptDoc("ab\n\n🧪Z");
    const fullText = "ab\n\n🧪Z";

    expect(promptTextOffsetToDocPosition(buildPromptDoc(""), 0)).toBe(0);
    expect(promptTextOffsetToDocPosition(doc, 0)).toBe(0);
    expect(promptTextOffsetToDocPosition(doc, 1)).toBe(2);
    expect(promptTextOffsetToDocPosition(doc, 2)).toBe(3);
    expect(promptTextOffsetToDocPosition(doc, 3)).toBe(5);
    expect(promptTextOffsetToDocPosition(doc, 4)).toBe(7);
    expect(promptTextOffsetToDocPosition(doc, 5)).toBe(8);
    expect(promptTextOffsetToDocPosition(doc, 6)).toBe(9);
    expect(promptTextOffsetToDocPosition(doc, fullText.length)).toBe(10);
    expect(promptTextOffsetToDocPosition(doc, fullText.length + 100)).toBe(doc.content.size);
  });

  test("inserts and persists a line break for Shift+Enter", () => {
    const { editor, editorRef, onChange, onKeyDown } = renderPromptEditor({
      value: "first line",
    });

    act(() => {
      editorRef.current?.focusAtEnd();
    });

    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(editorRef.current?.getText()).toBe("first line\n");
    expect(onChange).toHaveBeenLastCalledWith("first line\n");
  });

  test("removes a trailing empty line with Backspace", () => {
    const { editor, editorRef, onChange, onKeyDown } = renderPromptEditor({
      value: "first line\n",
    });

    act(() => {
      editorRef.current?.focusAtEnd();
    });
    fireEvent.keyDown(editor, {
      key: "Backspace",
      code: "Backspace",
      keyCode: 8,
    });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(editorRef.current?.getText()).toBe("first line");
    expect(onChange).toHaveBeenLastCalledWith("first line");
  });

  test("inserts a new line with Enter when the composer shortcut does not consume it", () => {
    const { editor, editorRef, onChange, onKeyDown } = renderPromptEditor({
      value: "first line\nsecond line",
    });

    act(() => {
      editorRef.current?.focusAtEnd();
    });
    fireEvent.keyDown(editor, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
    });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(editorRef.current?.getText()).toBe("first line\nsecond line\n");
    expect(onChange).toHaveBeenLastCalledWith("first line\nsecond line\n");
  });

  test("keeps imperative multiline insertion structurally editable", () => {
    const { editor, editorRef } = renderPromptEditor({
      value: "first line",
    });

    act(() => {
      editorRef.current?.focusAtEnd();
      editorRef.current?.insertText("\n");
    });
    expect(editorRef.current?.getText()).toBe("first line\n");

    fireEvent.keyDown(editor, {
      key: "Backspace",
      code: "Backspace",
      keyCode: 8,
    });

    expect(editorRef.current?.getText()).toBe("first line");
  });

  test("preserves consecutive empty lines from plain-text paste", () => {
    const { editor, editorRef, onChange } = renderPromptEditor({
      value: "",
    });
    const { clipboardData } = createClipboardData({
      "text/plain": "first line\n\nthird line",
    });

    act(() => {
      editorRef.current?.focusAtEnd();
    });
    fireEvent.paste(editor, { clipboardData });

    expect(editorRef.current?.getText()).toBe("first line\n\nthird line");
    expect(onChange).toHaveBeenLastCalledWith("first line\n\nthird line");
  });

  test("copies prompt paragraphs with one newline per logical line", () => {
    const { editor, editorRef } = renderPromptEditor({
      value: "first line\n\nthird line",
    });
    const { clipboardData, data } = createClipboardData();
    const isMac = /Mac|iP(hone|[oa]d)/u.test(navigator.platform);

    act(() => {
      editorRef.current?.focusAtEnd();
    });
    fireEvent.keyDown(editor, {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      ctrlKey: !isMac,
      metaKey: isMac,
    });
    fireEvent.copy(editor, { clipboardData });

    expect(data.get("text/plain")).toBe("first line\n\nthird line");
  });

  test("keeps composer shortcuts ahead of the editing keymap", () => {
    const onKeyDown = vi.fn(() => true);
    const { editor, editorRef, onChange } = renderPromptEditor({
      value: "submit this",
      onKeyDown,
    });

    act(() => {
      editorRef.current?.focusAtEnd();
    });
    fireEvent.keyDown(editor, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
    });

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(editorRef.current?.getText()).toBe("submit this");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("keeps synthetic context suggestions inside the editor while the query changes", () => {
    const suggestionStates: Array<
      ReturnType<NonNullable<ComposerPromptEditorHandle["getSuggestionState"]>>
    > = [];
    const { editor, editorRef } = renderPromptEditor({
      value: "",
      onSuggestionStateChange: (state) => suggestionStates.push(state),
    });

    act(() => {
      editorRef.current?.focus();
      editorRef.current?.toggleContextSuggestions();
    });
    expect(document.activeElement).toBe(editor);
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      activation: "synthetic",
      kind: "at-mention",
      query: "",
      trigger: "+",
    });

    act(() => {
      editorRef.current?.insertText("bro");
    });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      activation: "synthetic",
      kind: "at-mention",
      query: "bro",
    });
    expect(suggestionStates.at(-1)?.query).toBe("bro");
  });

  test("derives typed at-mention suggestions and inserts an atomic persisted mention", () => {
    const { editor, editorRef, onChange } = renderPromptEditor({
      value: "Use ",
    });

    act(() => {
      editorRef.current?.focusAtEnd();
      editorRef.current?.insertText("@bro");
    });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      activation: "typed",
      kind: "at-mention",
      query: "bro",
      trigger: "@",
    });

    act(() => {
      editorRef.current?.insertMention({
        kind: "plugin",
        name: "Browser",
        displayName: "Browser",
        path: "plugin://browser@openai-bundled",
        iconUrl: "app://fs/@fs/plugins/browser/icon.png",
        brandColor: "#013B7B",
      });
    });

    const mention = editor.querySelector("[plugin-mention-path='plugin://browser@openai-bundled']");
    expect(mention?.getAttribute("plugin-mention-icon")).toBe(
      "app://fs/@fs/plugins/browser/icon.png",
    );
    expect(mention?.getAttribute("contenteditable")).toBe("false");
    expect(mention?.getAttribute("data-prompt-link-label")).toBe("@Browser");
    expect(mention?.textContent).toBe("Browser");
    expect(editorRef.current?.getPersistedText()).toBe(
      "Use [@Browser](plugin://browser@openai-bundled) ",
    );
    expect(editorRef.current?.getSuggestionState().active).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("Use [@Browser](plugin://browser@openai-bundled) ");
  });

  test("keeps a dismissed typed match closed while its query continues", () => {
    const { editor, editorRef } = renderPromptEditor({ value: "" });

    act(() => {
      editorRef.current?.focus();
      editorRef.current?.insertText("@bro");
    });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: false,
      dismissedMatch: {
        query: "bro",
        trigger: "@",
      },
    });

    act(() => {
      editorRef.current?.insertText("wser");
    });
    expect(editorRef.current?.getSuggestionState().active).toBe(false);

    act(() => {
      editorRef.current?.insertText(" @new");
    });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      kind: "at-mention",
      query: "new",
      trigger: "@",
    });
  });

  test("derives the dedicated skill surface and persists app mentions with a dollar prefix", () => {
    const { editor, editorRef } = renderPromptEditor({ value: "Use " });

    act(() => {
      editorRef.current?.focusAtEnd();
      editorRef.current?.insertText("$plug");
    });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      activation: "typed",
      kind: "skill-mention",
      query: "plug",
      trigger: "$",
    });

    act(() => {
      editorRef.current?.insertMention({
        kind: "app",
        name: "plugin-management",
        displayName: "Plugin Management",
        path: "app://plugin-management",
      });
    });

    const mention = editor.querySelector("[app-mention-path='app://plugin-management']");
    expect(mention?.getAttribute("data-prompt-link-label")).toBe("$plugin-management");
    expect(mention?.textContent).toBe("Plugin Management");
    expect(editorRef.current?.getPersistedText()).toBe(
      "Use [$plugin-management](app://plugin-management) ",
    );
  });

  test("reconciles restored mention metadata to current canonical labels", () => {
    const value = [
      "Use [$plugin-management](app://plugin-management)",
      "with [$plugin-creator](/skills/plugin-creator/SKILL.md)",
      "and [@browser](plugin://browser@openai-bundled)",
    ].join(" ");
    const { editor, editorRef } = renderPromptEditor({ value });

    act(() => {
      editorRef.current?.syncMentionMetadata({
        apps: [
          {
            id: "plugin-management",
            name: "Plugin Management",
            description: "Manage plugins",
            logoUrl: null,
            logoUrlDark: null,
          },
        ],
        plugins: [
          {
            name: "Browser",
            displayName: "Browser",
            description: "Control the browser",
            path: "plugin://browser@openai-bundled",
            iconUrl: null,
            iconUrlDark: null,
            brandColor: "#4b8df8",
          },
        ],
        skills: [
          {
            name: "plugin-creator",
            displayName: "Plugin Creator",
            description: "Create plugins",
            iconUrl: null,
            brandColor: null,
            path: "/skills/plugin-creator/SKILL.md",
          },
        ],
      });
    });

    expect(editor.querySelector("[app-mention-path='app://plugin-management']")?.textContent).toBe(
      "Plugin Management",
    );
    expect(
      editor.querySelector("[skill-mention-path='/skills/plugin-creator/SKILL.md']")?.textContent,
    ).toBe("Plugin Creator");
    expect(
      editor.querySelector("[plugin-mention-path='plugin://browser@openai-bundled']")?.textContent,
    ).toBe("Browser");
    expect(editorRef.current?.getPersistedText()).toBe(value.replace("[@browser]", "[@Browser]"));
  });

  test("uses slash submenu transactions for source reset and synthetic dismissal", () => {
    const { editor, editorRef } = renderPromptEditor({ value: "" });

    act(() => {
      editorRef.current?.focus();
      editorRef.current?.openSlashSubmenu({
        kind: "slash-command",
        commandId: "model",
      });
    });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      activation: "synthetic",
      kind: "slash-command",
      source: {
        kind: "slash-command",
        commandId: "model",
      },
    });

    fireEvent.keyDown(editor, { key: "Backspace" });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      source: null,
    });

    act(() => {
      editorRef.current?.insertText("query");
    });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(editorRef.current?.getSuggestionState().active).toBe(false);
    expect(editorRef.current?.getPersistedText()).toBe("");
  });

  test("does not treat Backspace as a close shortcut for the synthetic plus menu", () => {
    const { editor, editorRef } = renderPromptEditor({ value: "" });

    act(() => {
      editorRef.current?.focus();
      editorRef.current?.toggleContextSuggestions();
    });
    fireEvent.keyDown(editor, { key: "Backspace" });

    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      activation: "synthetic",
      kind: "at-mention",
    });
  });

  test("hydrates persisted mention markup back into an atomic editor node", () => {
    const value = [
      "Use [@Browser](plugin://browser@openai-bundled)",
      "with [$PDF](/skills/pdf/SKILL.md)",
      "and [notes.md](docs/notes.md)",
      "plus [Release notes](sites-project://site-1)",
    ].join("\n");
    const { editor, editorRef } = renderPromptEditor({ value });

    expect(
      editor.querySelector("[plugin-mention-path='plugin://browser@openai-bundled']"),
    ).not.toBeNull();
    expect(editor.querySelector("[skill-mention-path='/skills/pdf/SKILL.md']")).not.toBeNull();
    expect(editor.querySelector("[at-mention-path='docs/notes.md']")).not.toBeNull();
    expect(
      editor.querySelector("[sites-project-mention-path='sites-project://site-1']"),
    ).not.toBeNull();
    expect(editorRef.current?.getPersistedText()).toBe(value);
  });

  test("copies atomic mentions using their persisted prompt representation", () => {
    const value = "Use [@Browser](plugin://browser@openai-bundled)";
    const { editor, editorRef } = renderPromptEditor({ value });
    const { clipboardData, data } = createClipboardData();
    const isMac = /Mac|iP(hone|[oa]d)/u.test(navigator.platform);

    act(() => editorRef.current?.focusAtEnd());
    fireEvent.keyDown(editor, {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      ctrlKey: !isMac,
      metaKey: isMac,
    });
    fireEvent.copy(editor, { clipboardData });

    expect(data.get("text/plain")).toBe(value);
  });

  test("routes suggestion navigation through the editor before composer shortcuts", () => {
    const onKeyDown = vi.fn(() => true);
    const onSuggestionAction = vi.fn(() => true);
    const { editor, editorRef } = renderPromptEditor({
      value: "",
      onKeyDown,
      onSuggestionAction,
    });

    act(() => {
      editorRef.current?.focus();
      editorRef.current?.toggleContextSuggestions();
    });
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: "Tab" });

    expect(onSuggestionAction).toHaveBeenNthCalledWith(1, "next");
    expect(onSuggestionAction).toHaveBeenNthCalledWith(2, "insert-mention");
    expect(onSuggestionAction).toHaveBeenNthCalledWith(3, "complete-query");
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  test("lets composer shortcuts handle arrows when a suggestion surface has no rows", () => {
    const onKeyDown = vi.fn(() => true);
    const onSuggestionAction = vi.fn(() => false);
    const { editor, editorRef } = renderPromptEditor({
      value: "",
      onKeyDown,
      onSuggestionAction,
    });

    act(() => {
      editorRef.current?.focus();
      editorRef.current?.toggleContextSuggestions();
    });
    fireEvent.keyDown(editor, { key: "ArrowDown" });

    expect(onSuggestionAction).toHaveBeenCalledWith("next");
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
  test("question editors keep mention suggestions while disabling slash commands", async () => {
    const { editorRef } = renderPromptEditor({ value: "/plan", allowSlashCommands: false });
    expect(editorRef.current?.getSuggestionState().active).toBe(false);
    await act(async () => {
      editorRef.current?.setText("@readme");
      await Promise.resolve();
    });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      kind: "at-mention",
    });
    await act(async () => {
      editorRef.current?.setText("$review");
      await Promise.resolve();
    });
    expect(editorRef.current?.getSuggestionState()).toMatchObject({
      active: true,
      kind: "skill-mention",
    });
  });
});
