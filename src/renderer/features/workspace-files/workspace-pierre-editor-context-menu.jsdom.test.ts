import { TextDocument, type Editor, type EditorViewState } from "@pierre/diffs/edit";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  buildWorkspacePierreEditorContextMenu,
  openWorkspacePierreEditorNativeContextMenu,
  type WorkspacePierreEditorContextMenuItem,
} from "./workspace-pierre-editor-context-menu";
import { showNativeContextMenu } from "@/lib/native-context-menu";
import { readPlainTextFromClipboard, writeTextToClipboard } from "@/lib/clipboard";
import { toast } from "@/components/ui/toast";

vi.mock("@/lib/native-context-menu", () => ({ showNativeContextMenu: vi.fn() }));
vi.mock("@/lib/clipboard", () => ({
  readPlainTextFromClipboard: vi.fn(async () => ""),
  writeTextToClipboard: vi.fn(async () => true),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));

const originalExecCommand = document.execCommand;
const originalClipboard = navigator.clipboard;
let container: HTMLElement;
let textbox: HTMLElement;

function editorFixture(text = "first\nsecond") {
  const selections: NonNullable<EditorViewState["selections"]> = [
    { start: { line: 0, character: 1 }, end: { line: 1, character: 3 }, direction: -1 },
  ];
  const instance = {
    canUndo: true,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    focus: vi.fn(),
    getEditState: vi.fn(() => ({ document: new TextDocument("file", text) })),
    getViewState: vi.fn(() => ({ selections })),
    setViewState: vi.fn(),
    setSelections: vi.fn(),
  };
  return { instance, editor: instance as unknown as Editor, selections };
}

function action(items: WorkspacePierreEditorContextMenuItem[], id: string) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item || item.type === "separator") throw new Error(`Missing action ${id}`);
  return item;
}

function build(editor?: Editor, isCurrent = () => true) {
  return buildWorkspacePierreEditorContextMenu({ editor, textbox, container, isCurrent });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("section");
  textbox = document.createElement("div");
  textbox.tabIndex = 0;
  textbox.textContent = "Selected file text";
  container.append(textbox);
  document.body.append(container);
  document.getSelection()?.removeAllRanges();
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => true) });
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
});

describe("Files editor context menu", () => {
  test("keeps edit commands available with a caret while history reflects Pierre's timeline", () => {
    const { editor } = editorFixture();
    const items = build(editor);
    expect(items.map((item) => item.id)).toEqual([
      "file-undo",
      "file-redo",
      "file-history-separator",
      "file-cut",
      "file-copy",
      "file-paste",
      "file-select-all",
    ]);
    expect(action(items, "file-undo").enabled).toBe(true);
    expect(action(items, "file-redo").enabled).toBe(false);
    for (const id of ["file-cut", "file-copy", "file-paste"]) {
      expect(action(items, id).enabled).toBe(true);
    }
    expect(action(items, "file-select-all").nativeRole).toBeUndefined();
  });

  test("readonly snapshots disable edits and capture selected text for Copy", async () => {
    const empty = build();
    for (const id of ["file-undo", "file-redo", "file-cut", "file-copy", "file-paste"]) {
      expect(action(empty, id).enabled).toBe(false);
    }
    expect(action(empty, "file-select-all").nativeRole).toBe("selectAll");
    document.getSelection()?.selectAllChildren(textbox);
    const selected = build();
    document.getSelection()?.removeAllRanges();
    expect(action(selected, "file-copy").enabled).toBe(true);
    await action(selected, "file-copy").onSelect?.();
    expect(writeTextToClipboard).toHaveBeenCalledExactlyOnceWith("Selected file text");
  });

  test.each(["file-cut", "file-copy", "file-paste", "file-select-all"])(
    "does not replay the callback after the desktop executes %s",
    async (id) => {
      const { editor, instance } = editorFixture();
      vi.mocked(showNativeContextMenu).mockResolvedValue(id);
      await openWorkspacePierreEditorNativeContextMenu(
        build(id === "file-select-all" ? undefined : editor),
        { x: 4, y: 8 },
        () => true,
      );
      expect(instance.setViewState).not.toHaveBeenCalled();
      expect(document.execCommand).not.toHaveBeenCalled();
      expect(writeTextToClipboard).not.toHaveBeenCalled();
      expect(readPlainTextFromClipboard).not.toHaveBeenCalled();
      expect(showNativeContextMenu).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id })]),
        { x: 4, y: 8 },
      );
    },
  );

  test("dispatches native-menu Undo once and leaves disabled or retired commands alone", async () => {
    const { editor, instance } = editorFixture();
    const menu = build(editor);
    vi.mocked(showNativeContextMenu).mockResolvedValue("file-undo");
    await openWorkspacePierreEditorNativeContextMenu(menu, {}, () => true);
    expect(instance.undo).toHaveBeenCalledOnce();
    expect(instance.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    vi.mocked(showNativeContextMenu).mockResolvedValue("file-redo");
    await openWorkspacePierreEditorNativeContextMenu(menu, {}, () => true);
    expect(instance.redo).not.toHaveBeenCalled();
    vi.mocked(showNativeContextMenu).mockResolvedValue("file-undo");
    await openWorkspacePierreEditorNativeContextMenu(menu, {}, () => false);
    expect(instance.undo).toHaveBeenCalledOnce();
  });

  test("appends file destinations after editing and dispatches nested file choices once", async () => {
    const select = vi.fn(async () => undefined);
    const { editor, instance } = editorFixture();
    const items = build(editor);
    vi.mocked(showNativeContextMenu).mockResolvedValue("file-reference:open-with:cursor");
    await openWorkspacePierreEditorNativeContextMenu(items, {}, () => true, {
      items: [
        {
          id: "file-reference:open-with",
          label: "Open with",
          type: "submenu",
          submenu: [{ id: "file-reference:open-with:cursor", label: "Cursor" }],
        },
      ],
      select,
    });
    expect(select).toHaveBeenCalledExactlyOnceWith("file-reference:open-with:cursor");
    expect(instance.undo).not.toHaveBeenCalled();
    const menu = vi.mocked(showNativeContextMenu).mock.calls[0]![0];
    expect(menu.at(-3)).toMatchObject({ id: "file-select-all" });
    expect(menu.at(-2)).toEqual({ type: "separator" });
    expect(menu.at(-1)).toMatchObject({ id: "file-reference:open-with", type: "submenu" });
  });

  test("does not publish file actions for an editor retired while preparing destinations", async () => {
    const select = vi.fn(async () => undefined);
    await openWorkspacePierreEditorNativeContextMenu(build(), {}, () => false, {
      items: [{ id: "file-reference:save", label: "Save as…" }],
      select,
    });
    expect(showNativeContextMenu).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  test.each(["file-cut", "file-copy"])(
    "restores the captured selection before fallback %s",
    async (id) => {
      const { editor, instance, selections } = editorFixture();
      const menu = build(editor);
      instance.getViewState.mockReturnValue({ selections: [] });
      const focus = vi.spyOn(textbox, "focus");
      await action(menu, id).onSelect?.();
      expect(instance.setViewState).toHaveBeenCalledExactlyOnceWith({ selections });
      expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      expect(document.execCommand).toHaveBeenCalledExactlyOnceWith(
        id === "file-cut" ? "cut" : "copy",
      );
      expect(instance.setViewState.mock.invocationCallOrder[0]).toBeLessThan(
        focus.mock.invocationCallOrder[0]!,
      );
      expect(focus.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(document.execCommand).mock.invocationCallOrder[0]!,
      );
    },
  );

  test.each([
    { text: "", line: 0, character: 0 },
    { text: "first\nsecond", line: 1, character: 6 },
    { text: "first\n", line: 1, character: 0 },
  ])("Select all reaches the document end for $text", async ({ text, line, character }) => {
    const { editor, instance } = editorFixture(text);
    await action(build(editor), "file-select-all").onSelect?.();
    expect(instance.setSelections).toHaveBeenCalledExactlyOnceWith([
      { start: { line: 0, character: 0 }, end: { line, character }, direction: "forward" },
    ]);
    expect(instance.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  test("reports an unreadable browser clipboard instead of changing the selection", async () => {
    vi.mocked(readPlainTextFromClipboard).mockRejectedValueOnce(new Error("Denied"));
    const { editor, instance } = editorFixture();
    await action(build(editor), "file-paste").onSelect?.();
    expect(toast.danger).toHaveBeenCalledExactlyOnceWith("Could not paste from clipboard");
    expect(instance.setViewState).not.toHaveBeenCalled();
  });
});
