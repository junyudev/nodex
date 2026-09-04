import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { NodexDropdownSurface } from "@/components/ui/dropdown";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
  type NodexContextMenuItemProps,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import {
  attachNodexClipboardEnvelope,
  attachNodexStructuralClipboardWriteClaim,
  decodeNodexStructuralClipboardDescriptor,
  encodeNodexStructuralClipboardDescriptor,
  inspectNodexClipboardHtml,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
} from "../../../../shared/clipboard-paste";
import type { ClipboardPastePayload } from "../../../../shared/types";
import type { NfmPasteTarget } from "./nfm-paste-target";
import { attachNativePastePayload } from "./nfm-paste-event";

type NfmEditorCommand = "cut" | "copy" | "paste";

interface NfmEditorCommandEditor {
  isEditable?: boolean;
  pasteHTML?: (html: string, raw?: boolean) => void;
  pasteMarkdown?: (markdown: string) => void;
  pasteText?: (text: string) => boolean | undefined;
  prosemirrorView?: {
    dom?: HTMLElement;
    focus: () => void;
    editable?: boolean;
    state?: {
      selection?: {
        empty?: boolean;
      };
    };
  };
}

interface NfmEditorContextMenuProps {
  editor: NfmEditorCommandEditor;
  children: ReactNode;
  onPreparePaste?: () => NfmPasteTarget;
}

interface NfmEditorContextMenuContentProps {
  selectionEmpty: boolean;
  editable: boolean;
  onCommand: (command: NfmEditorCommand) => void;
}

const MENU_ITEM_CLASS_NAME = cn(
  "no-drag cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden",
  "focus:bg-token-list-hover-background data-highlighted:bg-token-list-hover-background",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
);

const SHORTCUT_CLASS_NAME = "ml-6 shrink-0 text-sm text-token-description-foreground";

function focusEditor(editor: NfmEditorCommandEditor) {
  editor.prosemirrorView?.focus();
}

function hasClipboardPayload(
  payload: ClipboardPastePayload | null | undefined,
): payload is ClipboardPastePayload {
  return (
    typeof payload?.blocknoteHtml === "string" ||
    typeof payload?.html === "string" ||
    typeof payload?.markdown === "string" ||
    typeof payload?.text === "string" ||
    payload?.structuralEnvelope !== undefined ||
    payload?.structuralWriteClaim !== undefined ||
    payload?.structuralDescriptor !== undefined ||
    (payload?.items?.length ?? 0) > 0
  );
}

async function readNativeClipboardPayload(): Promise<ClipboardPastePayload | null> {
  try {
    const payload = await window.api?.readPasteClipboard?.();
    return hasClipboardPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function readBrowserClipboardPayload(): Promise<ClipboardPastePayload | null> {
  if (typeof navigator === "undefined") return null;
  const clipboard = navigator.clipboard;
  if (!clipboard) return null;

  if (typeof clipboard.read === "function") {
    try {
      const items = await clipboard.read();
      const payload: ClipboardPastePayload = {};

      for (const item of items) {
        if (
          item.types.includes(NODEX_STRUCTURAL_CLIPBOARD_MIME) &&
          payload.structuralDescriptor === undefined
        ) {
          const encoded = await readClipboardItemText(item, NODEX_STRUCTURAL_CLIPBOARD_MIME);
          if (encoded) {
            payload.structuralDescriptor =
              decodeNodexStructuralClipboardDescriptor(encoded) ?? undefined;
          }
        }
        if (item.types.includes("blocknote/html") && payload.blocknoteHtml === undefined) {
          payload.blocknoteHtml = await readClipboardItemText(item, "blocknote/html");
        }
        if (item.types.includes("text/html") && payload.html === undefined) {
          payload.html = await readClipboardItemText(item, "text/html");
        }
        if (item.types.includes("text/markdown") && payload.markdown === undefined) {
          payload.markdown = await readClipboardItemText(item, "text/markdown");
        }
        if (item.types.includes("text/plain") && payload.text === undefined) {
          payload.text = await readClipboardItemText(item, "text/plain");
        }
      }

      if (hasClipboardPayload(payload)) {
        if (payload.html) {
          payload.structuralWriteClaim =
            inspectNodexClipboardHtml(payload.html).writeClaim ?? undefined;
        }
        return payload;
      }
    } catch {
      // Fall through to readText below. Some environments expose read() but
      // only allow text reads from user-initiated commands.
    }
  }

  if (typeof clipboard.readText !== "function") return null;

  try {
    const text = await clipboard.readText();
    return text.length > 0 ? { text } : null;
  } catch {
    return null;
  }
}

async function readClipboardItemText(
  item: ClipboardItem,
  type: string,
): Promise<string | undefined> {
  try {
    const blob = await item.getType(type);
    const text = await blob.text();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function dispatchSyntheticPaste(
  editor: NfmEditorCommandEditor,
  payload: ClipboardPastePayload,
): boolean {
  const target = editor.prosemirrorView?.dom;
  if (!target) return false;
  if (typeof ClipboardEvent === "undefined") return false;
  if (typeof DataTransfer === "undefined") return false;

  const dataTransfer = new DataTransfer();
  if (payload.structuralDescriptor) {
    dataTransfer.setData(
      NODEX_STRUCTURAL_CLIPBOARD_MIME,
      encodeNodexStructuralClipboardDescriptor(payload.structuralDescriptor),
    );
  }
  if (payload.blocknoteHtml) dataTransfer.setData("blocknote/html", payload.blocknoteHtml);
  const html = payload.structuralEnvelope
    ? attachNodexClipboardEnvelope(
        payload.html ?? "",
        payload.structuralEnvelope,
        payload.structuralWriteClaim,
      )
    : payload.structuralWriteClaim
      ? attachNodexStructuralClipboardWriteClaim(payload.html ?? "", payload.structuralWriteClaim)
      : payload.html;
  if (html) dataTransfer.setData("text/html", html);
  if (payload.markdown) dataTransfer.setData("text/markdown", payload.markdown);
  if (payload.text) dataTransfer.setData("text/plain", payload.text);

  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer,
  });
  attachNativePastePayload(event, payload);
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function runPasteCommand(
  editor: NfmEditorCommandEditor,
  onPreparePaste?: () => NfmPasteTarget,
): Promise<boolean> {
  const preparedPaste = onPreparePaste?.();
  try {
    const payload = window.api?.readPasteClipboard
      ? await readNativeClipboardPayload()
      : await readBrowserClipboardPayload();
    if (!payload || (preparedPaste && !preparedPaste.restore())) return false;

    if (payload && dispatchSyntheticPaste(editor, payload)) {
      return true;
    }

    if (payload?.structuralDescriptor) {
      return payload.text && editor.pasteText ? (editor.pasteText(payload.text) ?? false) : false;
    }

    if (payload?.blocknoteHtml && editor.pasteHTML) {
      editor.pasteHTML(payload.blocknoteHtml, true);
      return true;
    }

    if (payload?.html && editor.pasteHTML) {
      editor.pasteHTML(payload.html);
      return true;
    }

    if (payload?.markdown && editor.pasteMarkdown) {
      editor.pasteMarkdown(payload.markdown);
      return true;
    }

    if (payload?.text && editor.pasteText) {
      return editor.pasteText(payload.text) ?? false;
    }

    return false;
  } finally {
    preparedPaste?.release();
  }
}

export async function runNfmEditorContextCommand(
  editor: NfmEditorCommandEditor,
  command: NfmEditorCommand,
  execCommand: Document["execCommand"] | undefined = typeof document === "undefined"
    ? undefined
    : document.execCommand.bind(document),
  onPreparePaste?: () => NfmPasteTarget,
): Promise<boolean> {
  focusEditor(editor);

  if (command === "paste") {
    return runPasteCommand(editor, onPreparePaste);
  }

  if (execCommand?.(command)) {
    return true;
  }

  return false;
}

function getIsEditable(editor: NfmEditorCommandEditor): boolean {
  if (editor.isEditable === false) return false;
  if (editor.prosemirrorView?.editable === false) return false;
  return true;
}

function getSelectionEmpty(editor: NfmEditorCommandEditor): boolean {
  return editor.prosemirrorView?.state?.selection?.empty !== false;
}

export function NfmEditorContextMenuContent({
  selectionEmpty,
  editable,
  onCommand,
}: NfmEditorContextMenuContentProps) {
  return (
    <>
      <NfmEditorContextMenuItem
        disabled={!editable || selectionEmpty}
        onSelect={() => onCommand("cut")}
        shortcut="⌘X"
      >
        Cut
      </NfmEditorContextMenuItem>
      <NfmEditorContextMenuItem
        disabled={selectionEmpty}
        onSelect={() => onCommand("copy")}
        shortcut="⌘C"
      >
        Copy
      </NfmEditorContextMenuItem>
      <NfmEditorContextMenuItem
        disabled={!editable}
        onSelect={() => onCommand("paste")}
        shortcut="⌘V"
      >
        Paste
      </NfmEditorContextMenuItem>
    </>
  );
}

export function NfmEditorContextMenuPreview({
  selectionEmpty,
  editable,
  onCommand,
}: NfmEditorContextMenuContentProps) {
  return (
    <NodexDropdownSurface className="min-w-36 p-1">
      <NfmEditorContextMenuPreviewItem
        disabled={!editable || selectionEmpty}
        onClick={() => onCommand("cut")}
        shortcut="⌘X"
      >
        Cut
      </NfmEditorContextMenuPreviewItem>
      <NfmEditorContextMenuPreviewItem
        disabled={selectionEmpty}
        onClick={() => onCommand("copy")}
        shortcut="⌘C"
      >
        Copy
      </NfmEditorContextMenuPreviewItem>
      <NfmEditorContextMenuPreviewItem
        disabled={!editable}
        onClick={() => onCommand("paste")}
        shortcut="⌘V"
      >
        Paste
      </NfmEditorContextMenuPreviewItem>
    </NodexDropdownSurface>
  );
}

function NfmEditorContextMenuItem({
  children,
  shortcut,
  className,
  ...props
}: NodexContextMenuItemProps & {
  shortcut: string;
}) {
  return (
    <NodexContextMenuItem
      className={cn(MENU_ITEM_CLASS_NAME, "flex items-center gap-6", className)}
      rightSlot={<span className={SHORTCUT_CLASS_NAME}>{shortcut}</span>}
      {...props}
    >
      {children}
    </NodexContextMenuItem>
  );
}

function NfmEditorContextMenuPreviewItem({
  children,
  shortcut,
  className,
  disabled,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  shortcut: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        MENU_ITEM_CLASS_NAME,
        "flex w-full items-center gap-6 text-left disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className={SHORTCUT_CLASS_NAME}>{shortcut}</span>
    </button>
  );
}

export function NfmEditorContextMenu({
  editor,
  children,
  onPreparePaste,
}: NfmEditorContextMenuProps) {
  const [selectionEmpty, setSelectionEmpty] = useState(true);
  const [editable, setEditable] = useState(true);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) return;
      setSelectionEmpty(getSelectionEmpty(editor));
      setEditable(getIsEditable(editor));
    },
    [editor],
  );

  const handleCommand = useCallback(
    (command: NfmEditorCommand) => {
      void runNfmEditorContextCommand(editor, command, undefined, onPreparePaste)
        .then((handled) => {
          if (command === "paste" && !handled)
            toast.info("Couldn’t paste at the original position. Try again.");
        })
        .catch(() => toast.danger("Couldn’t complete the clipboard action. Try again."));
    },
    [editor, onPreparePaste],
  );

  const content = useMemo(
    () => (
      <NfmEditorContextMenuContent
        selectionEmpty={selectionEmpty}
        editable={editable}
        onCommand={handleCommand}
      />
    ),
    [editable, handleCommand, selectionEmpty],
  );

  return (
    <NodexContextMenuRoot onOpenChange={handleOpenChange}>
      <NodexContextMenuTrigger>
        <div className="contents">{children}</div>
      </NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent
          finalFocus={false}
          className="z-50 no-drag min-w-36 outline-hidden"
        >
          {content}
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}
