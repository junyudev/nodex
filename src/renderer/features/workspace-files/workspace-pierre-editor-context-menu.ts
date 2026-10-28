import type { Editor } from "@pierre/diffs/edit";
import type {
  NativeContextMenuActionItem,
  NativeContextMenuOptions,
  NativeContextMenuSeparatorItem,
} from "../../../shared/native-context-menu";
import { toast } from "@/components/ui/toast";
import { readPlainTextFromClipboard, writeTextToClipboard } from "@/lib/clipboard";
import { showNativeContextMenu } from "@/lib/native-context-menu";
import type { CapturedFileReferenceContextMenu } from "@/lib/file-reference-context-menu";

export type WorkspacePierreEditorContextMenuItem = (
  | NativeContextMenuActionItem
  | NativeContextMenuSeparatorItem
) & { readonly onSelect?: () => void | Promise<void> };

interface WorkspacePierreContextMenu {
  readonly editor?: Editor;
  readonly textbox: HTMLElement | null;
  readonly container: HTMLElement;
  readonly isCurrent: () => boolean;
}

/** Capture Pierre's selection before opening a menu can cancel the active gesture. */
export function buildWorkspacePierreEditorContextMenu({
  editor,
  textbox,
  container,
  isCurrent,
}: WorkspacePierreContextMenu): WorkspacePierreEditorContextMenuItem[] {
  const ownerDocument = container.ownerDocument;
  const document = editor?.getEditState()?.document;
  const selections = editor?.getViewState().selections;
  const selectedText = ownerDocument.getSelection()?.toString() ?? "";
  const restore = () => {
    editor?.setViewState({ selections });
    textbox?.focus({ preventScroll: true });
  };
  const executeNative = (command: "cut" | "copy" | "selectAll") => {
    if (!isCurrent()) return;
    restore();
    ownerDocument.execCommand(command);
  };
  return [
    {
      id: "file-undo",
      label: "Undo",
      accelerator: "CmdOrCtrl+Z",
      enabled: editor?.canUndo ?? false,
      onSelect: () => {
        if (!isCurrent()) return;
        editor?.undo();
        editor?.focus({ preventScroll: true });
      },
    },
    {
      id: "file-redo",
      label: "Redo",
      accelerator: "CmdOrCtrl+Shift+Z",
      enabled: editor?.canRedo ?? false,
      onSelect: () => {
        if (!isCurrent()) return;
        editor?.redo();
        editor?.focus({ preventScroll: true });
      },
    },
    { id: "file-history-separator", type: "separator" },
    {
      id: "file-cut",
      label: "Cut",
      accelerator: "CmdOrCtrl+X",
      nativeRole: "cut",
      enabled: editor !== undefined,
      onSelect: () => executeNative("cut"),
    },
    {
      id: "file-copy",
      label: "Copy",
      accelerator: "CmdOrCtrl+C",
      nativeRole: "copy",
      enabled: editor !== undefined || selectedText.length > 0,
      onSelect: async () => {
        if (!isCurrent()) return;
        if (editor) return executeNative("copy");
        await writeTextToClipboard(selectedText);
      },
    },
    {
      id: "file-paste",
      label: "Paste",
      accelerator: "CmdOrCtrl+V",
      nativeRole: "paste",
      enabled: editor !== undefined,
      onSelect: async () => {
        if (!isCurrent()) return;
        try {
          const text = await readPlainTextFromClipboard();
          if (!isCurrent()) return;
          restore();
          const transfer = new DataTransfer();
          transfer.setData("text/plain", text);
          textbox?.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              composed: true,
              cancelable: true,
            }),
          );
        } catch {
          if (isCurrent()) toast.danger("Could not paste from clipboard");
        }
      },
    },
    {
      id: "file-select-all",
      label: "Select all",
      accelerator: "CmdOrCtrl+A",
      nativeRole: editor ? undefined : "selectAll",
      onSelect: () => {
        if (!isCurrent()) return;
        if (!editor || !document) return executeNative("selectAll");
        const lastLine = document.lineCount - 1;
        editor.setSelections([
          {
            start: { line: 0, character: 0 },
            end: { line: lastLine, character: document.getLineLength(lastLine) },
            direction: "forward",
          },
        ]);
        editor.focus({ preventScroll: true });
      },
    },
  ];
}

export async function openWorkspacePierreEditorNativeContextMenu(
  items: readonly WorkspacePierreEditorContextMenuItem[],
  options: NativeContextMenuOptions,
  isCurrent: () => boolean,
  fileMenu?: CapturedFileReferenceContextMenu,
): Promise<void> {
  if (!isCurrent()) return;
  const nativeItems = items.map(({ onSelect: _onSelect, ...item }) => item);
  const selected = await showNativeContextMenu(
    fileMenu?.items.length
      ? [...nativeItems, { type: "separator" }, ...fileMenu.items]
      : nativeItems,
    options,
  );
  if (!isCurrent()) return;
  const item = items.find((item) => item.id === selected);
  if (!item) return await fileMenu?.select(selected);
  if (item.type === "separator" || item.enabled === false) return;
  // The desktop already executes native roles; replaying the callback would edit twice.
  if (item.nativeRole) return;
  await item.onSelect?.();
}
