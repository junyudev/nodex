import { act, render } from "@testing-library/react";
import { Editor } from "@pierre/diffs/edit";
import { StrictMode, createRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import {
  WorkspacePierreEditor,
  type WorkspacePierreEditorHandle,
  type WorkspacePierreEditorProps,
} from "./workspace-pierre-editor";
import "@/globals.css";
import { buildWorkspacePierreEditorContextMenu } from "./workspace-pierre-editor-context-menu";

vi.mock("@/lib/use-theme", () => ({ useTheme: () => ({ resolved: "light" }) }));
vi.mock("@/lib/use-code-font-size", () => ({ useCodeFontSize: () => ({ codeFontSize: 12 }) }));
installRendererThemeFixture();
const originalApi = window.api;
afterEach(() => {
  window.api = originalApi;
  vi.restoreAllMocks();
});

const base = "first\nsecond\nthird\nfourth\nfifth";
const changed = "first\nchanged\nthird\nfourth\nfifth";

function DraftEditor(props: Partial<WorkspacePierreEditorProps> & { initial?: string }) {
  const [value, setValue] = useState(props.initial ?? changed);
  return (
    <div style={{ width: 900, height: 350 }}>
      <WorkspacePierreEditor
        value={value}
        filename="example.txt"
        language={null}
        sourceIdentity="/repo/example.txt"
        documentVersion={0}
        ariaLabel="Text editor"
        {...props}
        onChange={(next) => {
          setValue(next);
          props.onChange?.(next);
        }}
      />
    </div>
  );
}

function shadow(container: HTMLElement): ShadowRoot {
  const root = container.querySelector("diffs-container")?.shadowRoot;
  if (!root) throw new Error("Editor rows are not ready");
  return root;
}

async function settle<T>(read: () => T): Promise<T> {
  const deadline = performance.now() + 10_000;
  let lastError: unknown;
  while (performance.now() < deadline) {
    try {
      return read();
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  throw lastError;
}

function spyOnEditor() {
  return vi.spyOn(Editor.prototype, "edit");
}

async function revealedEditor(spy: ReturnType<typeof spyOnEditor>) {
  return settle(() => {
    const editor = spy.mock.contexts.at(-1);
    if (!(editor instanceof Editor)) throw new Error("Editor has not attached");
    expect(editor.getFile()).toBeDefined();
    // getFile() precedes the queued onAttach callback that applies the pending reveal.
    expect(editor.getViewState().selections?.at(-1)).toBeDefined();
    return editor!;
  });
}

async function focusEditor(editor: Editor, container: HTMLElement) {
  // With a selection, Pierre's focus() queues native focus for a later frame.
  // Keyboard delivery must wait for the live additions-side contenteditable.
  await act(async () => editor.focus({ preventScroll: true }));
  await settle(() => {
    const root = shadow(container);
    const editable = root.querySelector("[data-code]:not([data-deletions]) [contenteditable=true]");
    expect(editable).not.toBeNull();
    expect(root.activeElement).toBe(editable);
    expect(container.ownerDocument.activeElement).toBe(root.host);
  });
}

describe("Files editable comparisons", () => {
  test("pastes at the menu's captured selection through Pierre and keeps the edit undoable", async () => {
    const edits = spyOnEditor();
    const browserRead = vi
      .spyOn(navigator.clipboard, "readText")
      .mockRejectedValue(new Error("Read permission denied"));
    const invoke = vi.fn(async () => ({ text: "pasted\r\nline" }));
    window.api = { invoke, on: () => () => {} };
    const view = render(
      <DraftEditor revealLocation={{ line: 2, column: 1, endLine: 2, endColumn: 8 }} />,
    );
    const editor = await revealedEditor(edits);
    await focusEditor(editor, view.container);
    const textbox = shadow(view.container).querySelector<HTMLElement>('[role="textbox"]');
    expect(textbox).not.toBeNull();
    const items = buildWorkspacePierreEditorContextMenu({
      editor,
      textbox,
      container: view.container,
      isCurrent: () => true,
    });
    await act(async () => {
      editor.setSelections([
        { start: { line: 4, character: 0 }, end: { line: 4, character: 0 }, direction: "none" },
      ]);
      await items.find((item) => item.id === "file-paste")?.onSelect?.();
    });
    await settle(() => {
      expect(editor.getText()).toBe("first\npasted\nline\nthird\nfourth\nfifth");
      expect(editor.canUndo).toBe(true);
    });
    expect(invoke).toHaveBeenCalledWith("clipboard:read-paste");
    expect(browserRead).not.toHaveBeenCalled();
    await act(async () => editor.undo());
    await settle(() => expect(editor.getText()).toBe(changed));
  });

  test("keyboard paste reads native text without treating JSON as multi-selection metadata", async () => {
    const edits = spyOnEditor();
    const text = '["one","two"]';
    const browserRead = vi
      .spyOn(navigator.clipboard, "readText")
      .mockRejectedValue(new Error("Read permission denied"));
    const invoke = vi.fn(async () => ({ text }));
    window.api = { invoke, on: () => () => {} };
    const view = render(<DraftEditor initial={base} revealLocation={{ line: 1, column: 1 }} />);
    const editor = await revealedEditor(edits);
    await act(async () => {
      editor.setSelections([
        { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, direction: "none" },
        { start: { line: 1, character: 0 }, end: { line: 1, character: 0 }, direction: "none" },
      ]);
    });
    await focusEditor(editor, view.container);
    await act(async () => {
      await userEvent.keyboard(
        navigator.platform.toLowerCase().includes("mac")
          ? "{Meta>}v{/Meta}"
          : "{Control>}v{/Control}",
      );
    });
    await settle(() =>
      expect(editor.getText()).toBe(`${text}first\n${text}second\nthird\nfourth\nfifth`),
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith("clipboard:read-paste");
    expect(browserRead).not.toHaveBeenCalled();
  });

  test("shows a plain document after the editor surface mounts twice", async () => {
    // Development renders mount every surface twice; the remounted view must still hold the file.
    const { container } = render(
      <StrictMode>
        <DraftEditor initial={base} />
      </StrictMode>,
    );
    await settle(() => {
      const lines = [...shadow(container).querySelectorAll("[data-content] > [data-line]")];
      expect(lines.map((line) => line.textContent)).toEqual(base.split("\n"));
    });
  });

  test("types into the new side, refreshes blocks, and keeps history through layout changes", async () => {
    const edits = spyOnEditor();
    const onChange = vi.fn();
    const navigation = vi.fn();
    const ref = createRef<WorkspacePierreEditorHandle>();
    const comparison = { oldContent: base, oldPath: "old.txt", layout: "unified" as const };
    const props = {
      ref,
      onChange,
      onChangeNavigationChange: navigation,
      revealLocation: { line: 4, column: 1 },
    };
    const view = render(<DraftEditor {...props} comparison={comparison} />);
    const editor = await revealedEditor(edits);
    await settle(() => {
      expect(editor.getViewState().selections?.at(-1)?.end.line).toBe(3);
      expect(navigation).toHaveBeenLastCalledWith({
        count: 1,
        activeIndex: -1,
        previousIndex: 0,
        nextIndex: -1,
      });
    });
    await focusEditor(editor, view.container);
    await act(async () => {
      await userEvent.keyboard("x");
    });
    const typed = "first\nchanged\nthird\nxfourth\nfifth";
    await settle(() => {
      expect(onChange).toHaveBeenLastCalledWith(typed);
      expect(navigation).toHaveBeenLastCalledWith({
        count: 2,
        activeIndex: 1,
        previousIndex: 0,
        nextIndex: -1,
      });
      expect(editor.canUndo).toBe(true);
    });
    const beforeLayout = editor.getViewState().selections;
    view.rerender(<DraftEditor {...props} comparison={{ ...comparison, layout: "split" }} />);
    await settle(() => {
      expect(
        shadow(view.container).querySelector("[data-code][data-additions] [contenteditable=true]"),
      ).not.toBeNull();
      expect(edits).toHaveBeenCalledTimes(1);
      expect(editor.getText()).toBe(typed);
      expect(editor.getViewState().selections).toEqual(beforeLayout);
    });
    await act(async () => editor.undo());
    await settle(() => {
      expect(onChange).toHaveBeenLastCalledWith(changed);
      expect(navigation.mock.lastCall?.[0]?.count).toBe(1);
    });
    await act(async () => editor.redo());
    await settle(() => expect(onChange).toHaveBeenLastCalledWith(typed));
    const position = editor.getViewState().selections?.at(-1)?.end;
    view.rerender(<DraftEditor {...props} comparison={null} revealLocation={undefined} />);
    await settle(() => {
      const plain = edits.mock.contexts.at(-1);
      if (!(plain instanceof Editor)) throw new Error("Plain editor has not attached");
      expect(plain).not.toBe(editor);
      expect(plain.getText()).toBe(typed);
      expect(plain.getViewState().selections?.at(-1)?.end).toEqual(position);
      expect(navigation).toHaveBeenLastCalledWith(null);
    });
  });

  test("navigates distinct blocks without wrapping and restores additions-side focus", async () => {
    const edits = spyOnEditor();
    const ref = createRef<WorkspacePierreEditorHandle>();
    const navigation = vi.fn();
    const view = render(
      <DraftEditor
        ref={ref}
        initial={"first\nnew second\nthird\nnew fourth\nfifth"}
        comparison={{ oldContent: base, oldPath: "example.txt", layout: "split" }}
        onChangeNavigationChange={navigation}
        revealLocation={{ line: 1, column: 1 }}
      />,
    );
    const editor = await revealedEditor(edits);
    await settle(() => {
      expect(editor.getText()).toBe("first\nnew second\nthird\nnew fourth\nfifth");
      expect(editor.getViewState().selections?.at(-1)?.end.line).toBe(0);
      expect(navigation.mock.lastCall?.[0]).toEqual({
        count: 2,
        activeIndex: -1,
        previousIndex: -1,
        nextIndex: 0,
      });
    });
    await act(async () => ref.current?.navigateChange("next"));
    await settle(() => {
      expect(editor.getViewState().selections?.at(-1)).toMatchObject({
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      });
      expect(navigation).toHaveBeenLastCalledWith({
        count: 2,
        activeIndex: 0,
        previousIndex: -1,
        nextIndex: 1,
      });
      expect(shadow(view.container).activeElement?.getAttribute("contenteditable")).toBe("true");
    });
    await act(async () => ref.current?.navigateChange("next"));
    await settle(() => expect(editor.getViewState().selections?.at(-1)?.end.line).toBe(3));
    await act(async () => ref.current?.navigateChange("next"));
    expect(editor.getViewState().selections?.at(-1)?.end.line).toBe(3);
    await act(async () => ref.current?.navigateChange("previous"));
    await settle(() => expect(editor.getViewState().selections?.at(-1)?.end.line).toBe(1));
  });

  test("snapshot content, including an empty snapshot, never creates an editable session", async () => {
    const edits = spyOnEditor();
    const onChange = vi.fn();
    const navigation = vi.fn();
    const comparison = {
      oldContent: base,
      oldPath: "example.txt",
      newContent: "saved snapshot",
      layout: "unified" as const,
    };
    const view = render(
      <DraftEditor
        onChange={onChange}
        onChangeNavigationChange={navigation}
        comparison={comparison}
      />,
    );
    await settle(() => {
      expect(shadow(view.container).querySelector("[data-line]")).not.toBeNull();
      expect(shadow(view.container).querySelector("[contenteditable=true]")).toBeNull();
      expect(navigation.mock.lastCall?.[0]?.count).toBe(1);
    });
    expect(edits).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(
      <DraftEditor
        onChange={onChange}
        comparison={{ ...comparison, newContent: "", layout: "split" }}
      />,
    );
    await settle(() =>
      expect(
        shadow(view.container).querySelector("[data-line-type=change-deletion]"),
      ).not.toBeNull(),
    );
    expect(shadow(view.container).querySelector("[contenteditable=true]")).toBeNull();
    expect(edits).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("keeps the draft and caret when opening and leaving an immutable snapshot", async () => {
    const edits = spyOnEditor();
    const onChange = vi.fn();
    const view = render(
      <DraftEditor onChange={onChange} revealLocation={{ line: 3, column: 2 }} />,
    );
    const editor = await revealedEditor(edits);
    await settle(() =>
      expect(editor.getViewState().selections?.at(-1)?.end).toEqual({ line: 2, character: 1 }),
    );
    view.rerender(
      <DraftEditor
        onChange={onChange}
        comparison={{
          oldContent: base,
          oldPath: "example.txt",
          newContent: "snapshot",
          layout: "unified",
        }}
      />,
    );
    await settle(() => {
      expect(shadow(view.container).querySelector("[contenteditable=true]")).toBeNull();
      expect(
        shadow(view.container).querySelector(
          '[data-content] > [data-line][data-line-type="change-addition"]',
        )?.textContent,
      ).toBe("snapshot");
    });
    view.rerender(<DraftEditor onChange={onChange} comparison={null} />);
    await settle(() => {
      const restored = edits.mock.contexts.at(-1);
      if (!(restored instanceof Editor)) throw new Error("Editor has not reattached");
      expect(restored).not.toBe(editor);
      expect(restored.getText()).toBe(changed);
      expect(restored.getViewState().selections?.at(-1)?.end).toEqual({ line: 2, character: 1 });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "unchanged text",
      content: base,
      line: 3,
      typed: "first\nsecond\nxthird\nfourth\nfifth",
      missingFinalNewline: true,
    },
    { name: "an empty file", content: "", line: 1, typed: "x", missingFinalNewline: false },
  ])(
    "edits $name in comparison and returns to zero blocks on undo",
    async ({ content, line, typed, missingFinalNewline }) => {
      const edits = spyOnEditor();
      const navigation = vi.fn();
      const onChange = vi.fn();
      const view = render(
        <DraftEditor
          initial={content}
          onChange={onChange}
          onChangeNavigationChange={navigation}
          comparison={{
            oldContent: content,
            oldPath: "example.txt",
            newContent: null,
            layout: "unified",
          }}
          revealLocation={{ line, column: 1 }}
        />,
      );
      const editor = await revealedEditor(edits);
      const noNewlineRow = () => shadow(view.container).querySelector("[data-no-newline]");
      await settle(() => {
        expect(navigation.mock.lastCall?.[0]?.count).toBe(0);
        expect(noNewlineRow() !== null).toBe(missingFinalNewline);
        expect(editor.getViewState().selections?.at(-1)?.end).toEqual({
          line: line - 1,
          character: 0,
        });
      });
      await focusEditor(editor, view.container);
      await act(async () => {
        await userEvent.keyboard("x");
      });
      await settle(() => {
        expect(onChange).toHaveBeenLastCalledWith(typed);
        expect(navigation.mock.lastCall?.[0]?.count).toBe(1);
      });
      await act(async () => editor.undo());
      await settle(() => {
        expect(onChange).toHaveBeenLastCalledWith(content);
        expect(navigation.mock.lastCall?.[0]?.count).toBe(0);
        expect(noNewlineRow() !== null).toBe(missingFinalNewline);
      });
    },
  );

  test.each(["unified", "split"] as const)(
    "keeps an empty new side editable in %s layout and restores it on undo",
    async (layout) => {
      const edits = spyOnEditor();
      const navigation = vi.fn();
      const onChange = vi.fn();
      const view = render(
        <DraftEditor
          initial="before"
          onChange={onChange}
          onChangeNavigationChange={navigation}
          comparison={{ oldContent: "before", oldPath: "example.txt", layout }}
          revealLocation={{ line: 1, column: 1 }}
        />,
      );
      const editor = await revealedEditor(edits);
      await act(async () => {
        editor.setSelections([
          {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 6 },
            direction: "forward",
          },
        ]);
      });
      await focusEditor(editor, view.container);
      await act(async () => {
        await userEvent.keyboard("{Backspace}");
      });
      await settle(() => {
        expect(onChange).toHaveBeenLastCalledWith("");
        expect(navigation.mock.lastCall?.[0]?.count).toBe(1);
        const line = shadow(view.container).querySelector(
          '[data-code]:not([data-deletions]) [contenteditable=true] > [data-line="1"]:not([data-line-type="change-deletion"])',
        );
        expect(line).not.toBeNull();
        expect(line?.textContent).toBe("");
      });
      await focusEditor(editor, view.container);
      await act(async () => {
        await userEvent.keyboard("x");
      });
      await settle(() => expect(onChange).toHaveBeenLastCalledWith("x"));
      await act(async () => editor.undo());
      await settle(() => expect(onChange).toHaveBeenLastCalledWith(""));
      await act(async () => editor.undo());
      await settle(() => {
        expect(onChange).toHaveBeenLastCalledWith("before");
        expect(navigation.mock.lastCall?.[0]?.count).toBe(0);
      });
    },
  );

  test("maps inline blame only to unchanged saved lines and retires old spans", async () => {
    const edits = spyOnEditor();
    const blame = { savedContent: base, labelForSavedLine: (line: number) => `Author of ${line}` };
    const view = render(
      <DraftEditor
        initial={`inserted\n${base}`}
        activeLineBlame={blame}
        comparison={{ oldContent: base, oldPath: "example.txt", layout: "unified" }}
        revealLocation={{ line: 2, column: 1 }}
      />,
    );
    const editor = await revealedEditor(edits);
    const span = await settle(() => {
      const span = shadow(view.container).querySelector(
        '[data-line="2"] > [data-pierre-editor-inline-blame]',
      );
      expect(span?.getAttribute("data-pierre-editor-inline-blame")).toBe("Author of 1");
      expect(span?.getAttribute("contenteditable")).toBe("false");
      expect(span?.getAttribute("aria-hidden")).toBe("true");
      return span!;
    });
    await focusEditor(editor, view.container);
    await act(async () => {
      await userEvent.keyboard("x");
    });
    await settle(() => {
      expect(shadow(view.container).querySelector("[data-pierre-editor-inline-blame]")).toBeNull();
      expect(span.isConnected).toBe(false);
    });
    await act(async () => {
      editor.setSelections([
        { start: { line: 2, character: 0 }, end: { line: 2, character: 0 }, direction: "none" },
      ]);
      editor.focus({ preventScroll: true });
      document.dispatchEvent(new Event("selectionchange"));
    });
    await settle(() =>
      expect(
        shadow(view.container)
          .querySelector("[data-pierre-editor-inline-blame]")
          ?.getAttribute("data-pierre-editor-inline-blame"),
      ).toBe("Author of 2"),
    );
    view.rerender(
      <DraftEditor initial={`inserted\n${base}`} activeLineBlame={null} comparison={null} />,
    );
    await settle(() =>
      expect(shadow(view.container).querySelector("[data-pierre-editor-inline-blame]")).toBeNull(),
    );
  });
  test("retires plain-editor blame when its row is virtualized and restores it on the active row", async () => {
    const edits = spyOnEditor();
    const content = Array.from({ length: 1200 }, (_, index) => `line ${index + 1}`).join("\n");
    const blame = {
      savedContent: content,
      labelForSavedLine: (line: number) => `Author of ${line}`,
    };
    const view = render(
      <DraftEditor
        initial={content}
        activeLineBlame={blame}
        revealLocation={{ line: 1, column: 1 }}
      />,
    );
    const editor = await revealedEditor(edits);
    const span = await settle(() => {
      const span = shadow(view.container).querySelector("[data-pierre-editor-inline-blame]");
      expect(span?.getAttribute("data-pierre-editor-inline-blame")).toBe("Author of 1");
      return span!;
    });
    const viewport = view.container.querySelector<HTMLElement>(".nodex-source-file")!;
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scrolled = new Promise<void>((resolve) => {
        viewport.addEventListener("scroll", () => resolve(), { once: true });
      });
      viewport.scrollTo({ top: 100_000, behavior: "instant" });
      await scrolled;
    });
    await settle(() => {
      expect(shadow(view.container).querySelector('[data-content] > [data-line="1"]')).toBeNull();
      expect(shadow(view.container).querySelector("[data-pierre-editor-inline-blame]")).toBeNull();
      expect(span.isConnected).toBe(false);
    });
    await act(async () => {
      editor.setSelections([
        {
          start: { line: 1199, character: 0 },
          end: { line: 1199, character: 0 },
          direction: "none",
        },
      ]);
      editor.focus({ preventScroll: true });
      document.dispatchEvent(new Event("selectionchange"));
    });
    await settle(() => {
      const labels = shadow(view.container).querySelectorAll("[data-pierre-editor-inline-blame]");
      expect(labels).toHaveLength(1);
      expect(labels[0]?.getAttribute("data-pierre-editor-inline-blame")).toBe("Author of 1200");
    });
  });
});
