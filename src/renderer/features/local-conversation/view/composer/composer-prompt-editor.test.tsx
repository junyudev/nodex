import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, StrictMode, useEffect, useRef } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { resolveSubagentAvatarAsset } from "../shared/subagent-avatar";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import { activateAppLocale, resetAppLocaleForTests } from "@/lib/i18n";
import {
  parseComposerPromptMentionLink,
  serializeComposerPromptMentionLink,
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "./composer-prompt-editor";

function renderPromptEditor({
  value,
  singleLine = false,
  allowSlashCommands = true,
  allowMentions = true,
  onKeyDown = vi.fn(() => false),
  onOpenSkill,
  onLargeTextPaste,
  onPasteFiles,
  onSuggestionStateChange,
  onSuggestionAction,
  promptKeywords,
}: {
  value: string;
  promptKeywords?: Parameters<typeof ComposerPromptEditor>[0]["promptKeywords"];
  singleLine?: boolean;
  allowSlashCommands?: boolean;
  allowMentions?: boolean;
  onKeyDown?: (event: KeyboardEvent) => boolean;
  onOpenSkill?: Parameters<typeof ComposerPromptEditor>[0]["onOpenSkill"];
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
      allowMentions={allowMentions}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onOpenSkill={onOpenSkill}
      onLargeTextPaste={onLargeTextPaste}
      onPasteFiles={onPasteFiles}
      onSuggestionStateChange={onSuggestionStateChange}
      onSuggestionAction={onSuggestionAction}
      {...(promptKeywords ? { promptKeywords } : {})}
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
  test("switches a Session mention's visible title without changing the draft", async () => {
    const value = "Ask [@New chat](thread://session-id)";
    const { editorRef, onChange } = renderPromptEditor({ value });
    expect(screen.getByText("@New chat")).toBeDefined();
    try {
      await act(() => activateAppLocale("zh-CN"));
      expect(screen.getByText("@新聊天")).toBeDefined();
      expect(editorRef.current?.getPersistedText()).toBe(value);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => resetAppLocaleForTests());
    }
  });
  test.each([
    ["Keep my draft.", "end", "Keep my draft. More words."],
    ["Keep my draft. ", "end", "Keep my draft. More words."],
    ["leftright", "middle", "left More words. right"],
    ["Keep my draft.", "outside", "Keep my draft. More words."],
    ["", "end", "More words."],
  ] as const)(
    "inserts dictation with word boundaries for %s at %s",
    async (value, position, expected) => {
      const { editor, editorRef, onChange } = renderPromptEditor({ value });
      await act(async () => {
        if (position === "end") editorRef.current!.focusAtEnd();
        else editorRef.current!.focus();
        if (position === "middle") {
          const node = editor.firstChild!.firstChild!;
          document.getSelection()!.setBaseAndExtent(node, 4, node, 4);
          document.dispatchEvent(new Event("selectionchange"));
        }
        if (position === "outside") document.getSelection()!.removeAllRanges();
      });
      if (position === "middle")
        await waitFor(() => expect(editorRef.current!.getSelection()?.from).toBe(5));
      await act(async () => {
        editorRef.current!.insertDictationText("  More words.  ");
      });
      expect(editorRef.current!.getText()).toBe(expected);
      expect(onChange).toHaveBeenLastCalledWith(expected);
      const cursor = position === "middle" ? 18 : expected.length + 1;
      expect(editorRef.current!.getSelection()).toEqual({ from: cursor, to: cursor });
    },
  );

  test("keeps a one-time focus request when its effects run a second time", () => {
    const FocusedOnce = () => {
      const editorRef = useRef<ComposerPromptEditorHandle>(null);
      const requested = useRef(false);
      useEffect(() => {
        if (requested.current) return;
        requested.current = true;
        editorRef.current?.focusAtEnd();
      }, []);
      return (
        <ComposerPromptEditor
          ref={editorRef}
          value="A first task"
          placeholder="Do anything"
          disabled={false}
          onChange={vi.fn()}
          onKeyDown={vi.fn(() => false)}
        />
      );
    };
    const { container } = render(
      <StrictMode>
        <FocusedOnce />
      </StrictMode>,
    );
    expect(document.activeElement).toBe(container.querySelector("[contenteditable='true']"));
    expect(document.getSelection()?.anchorOffset).toBe("A first task".length);
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

  test.each([
    ["line breaks", "first line<br>second line", "first line\nsecond line"],
    ["a code block", "<pre>const a = 1;\nconst b = 2;</pre>", "const a = 1;\nconst b = 2;"],
    [
      "an editor's lines",
      "<div><div><span>const a = 1;</span></div><div><br></div><div><span>b();</span></div></div>",
      "const a = 1;\n\nb();",
    ],
  ])("keeps every line of rich text pasted with %s", (_source, html, text) => {
    const { editor, editorRef } = renderPromptEditor({ value: "" });
    const { clipboardData } = createClipboardData({ "text/plain": text, "text/html": html });

    act(() => editorRef.current?.focusAtEnd());
    fireEvent.paste(editor, { clipboardData });

    expect(editorRef.current?.getText()).toBe(text);
  });

  test("keeps mention atoms whole when pasting another Composer's copy", () => {
    const source = renderPromptEditor({ value: "Ask [@notes.md](/repo/notes.md) now" });
    const mention = source.editor.querySelector("[data-composer-mention='true']");
    if (!(mention instanceof HTMLElement)) throw new Error("Mention was not rendered");
    const { editor, editorRef } = renderPromptEditor({ value: "" });
    const { clipboardData } = createClipboardData({
      "text/plain": "Ask @notes.md now",
      "text/html": `<p>Ask ${mention.outerHTML} now</p>`,
    });

    act(() => editorRef.current?.focusAtEnd());
    fireEvent.paste(editor, { clipboardData });

    expect(editorRef.current?.getText()).toBe(source.editorRef.current?.getText());
    expect(editor.querySelector("[data-composer-mention='true']")).not.toBeNull();
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

  test("rebuilds a subagent mention's identity from its target after restoring the draft", async () => {
    const value =
      "Ask [@Scout](agent://child-thread), [@Reviewer](subagent://other-child) and [@Chat](thread://ordinary-chat)";
    const { editor, editorRef, onChange } = renderPromptEditor({ value });
    const avatarSources = (threadId: string) =>
      [...editor.querySelectorAll(`[data-subagent-avatar-seed="${threadId}"] img`)].map((image) =>
        image.getAttribute("src"),
      );
    const asset = resolveSubagentAvatarAsset("child-thread");
    expect(avatarSources("child-thread")).toEqual([asset.light, asset.dark]);
    expect(avatarSources("other-child")).toHaveLength(2);
    expect(avatarSources("ordinary-chat")).toEqual([]);
    expect(editorRef.current?.getPersistedText()).toBe(value);
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => {
      editorRef.current?.insertMention({
        kind: "agent",
        name: "renamed",
        displayName: "Renamed",
        conversationId: "child-thread",
        path: "agent://child-thread",
      });
      await Promise.resolve();
    });
    const mention = editor.querySelector('[agent-mention-name="renamed"]');
    expect([...mention!.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual(
      [asset.light, asset.dark],
    );
    expect(editorRef.current?.getPersistedText()).not.toContain(asset.light);
    expect(editorRef.current?.getPersistedText()).not.toContain(asset.dark);
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

test("Page links round-trip as inline atoms with canonical ids and escaped titles", async () => {
  const mention = {
    kind: "page" as const,
    name: "Plan [v2] \\ draft",
    path: buildPageDeepLink({ pageId: "page-a" }),
  };
  const serialized = serializeComposerPromptMentionLink(mention);
  const match = /^\[((?:\\.|[^\]\\\n])+)\]\(([^)\n]+)\)$/u.exec(serialized)!;
  expect(parseComposerPromptMentionLink(match[1]!, match[2]!)).toMatchObject(mention);
  const editor = renderPromptEditor({ value: serialized });
  const atom = editor.editor.querySelector('[data-mention-kind="page"]');
  expect(atom?.getAttribute("data-mention-display-name")).toBe(mention.name);
  expect(editor.editorRef.current?.getPersistedText()).toBe(serialized);
});
