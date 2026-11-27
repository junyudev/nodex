import { FormattedMessage, getIntl } from "@/lib/i18n";
import { resolveCodexRendererCommandPlatform } from "../../../lib/codex-window-runtime";
import { formatAcceleratorLabel } from "../../../../shared/command-keybindings";
import { type MouseEvent, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { NodexDropdownSeparator } from "@/components/ui/dropdown";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
  type NodexContextMenuItemProps,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { CopyIcon, NfmSideMenuTurnIntoIcon, PageMenuCopyLinkIcon } from "@/components/shared/icons";
import { Clipboard, Scissors } from "@/components/shared/icons/generic-icons";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
import { toast } from "@/components/ui/toast";
import { useBlockReferenceHostRuntime } from "../../block-documents/block-reference-runtime-context";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import { copyTextWithFeedback } from "@/lib/copy-with-feedback";
import { resolvePageCopyRequest } from "@/lib/page-copy-model";
import { resolvePageReferenceDisabledReason } from "@/lib/page-reference-picker/candidate-model";
import { libraryContentRoute } from "../../../../shared/content-routing-context";
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
import { isEventWithinCurrentTarget } from "@/lib/react-event-ownership";
import { attachNativePastePayload } from "./nfm-paste-event";
import {
  type NfmPageMentionMenuEditor,
  type PageMentionContextTarget,
  resolvePageMentionContextTarget,
  turnPageMentionIntoEmbed,
  setPageMentionContextHighlight,
} from "./nfm-page-mention-context-target";

type NfmEditorCommand = "cut" | "copy" | "paste";

interface NfmEditorCommandEditor {
  isEditable?: boolean;
  pasteHTML?: (html: string, raw?: boolean) => void;
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
  editor: NfmEditorCommandEditor & NfmPageMentionMenuEditor;
  children: ReactNode;
  onPreparePaste?: () => NfmPasteTarget;
}

interface NfmEditorContextMenuContentProps {
  selectionEmpty: boolean;
  editable: boolean;
  onCommand: (command: NfmEditorCommand) => void;
}

/**
 * A right-clicked Page Mention leads the menu with its own actions. Click already opens the
 * Page, so changing how the occurrence is presented lives here rather than on the chip.
 */
function NfmPageMentionContextMenuItems({
  target,
  editable,
  onTurnIntoEmbed,
}: {
  readonly target: PageMentionContextTarget;
  readonly editable: boolean;
  readonly onTurnIntoEmbed: () => void;
}) {
  const host = useBlockReferenceHostRuntime();
  const routingContext = host?.contentRoutingContext ?? libraryContentRoute;
  const read = usePageTargetReadModel(routingContext, host ? target.pageId : "");
  const page = read.data?.status === "available" ? read.data.page : null;
  // Embedding follows `/Embed page…`: an active Page that is neither this Page nor an ancestor.
  const canEmbed =
    editable &&
    target.embeddable &&
    page?.lifecycle === "active" &&
    resolvePageReferenceDisabledReason({
      pageId: target.pageId,
      hostPageId: host?.hostPageId ?? null,
      ancestorPageIds: host?.ancestorPageIds ?? [],
      intent: "reference_block",
    }) === null;

  return (
    <>
      {page && host?.openPage ? (
        <NfmEditorContextMenuItem
          leftSlot={<NativeMenuIcon iconKey="openIn" />}
          onSelect={() => {
            void host.openPage?.({
              pageId: page.pageId,
              titleSnapshot: page.title,
            });
          }}
        >
          <FormattedMessage id="editor.nfmEditorContextMenu.openPage" defaultMessage="Open page" />
        </NfmEditorContextMenuItem>
      ) : null}
      {canEmbed ? (
        <NfmEditorContextMenuItem leftSlot={<NfmSideMenuTurnIntoIcon />} onSelect={onTurnIntoEmbed}>
          <FormattedMessage
            id="editor.nfmEditorContextMenu.turnIntoEmbed"
            defaultMessage="Turn into embed"
          />
        </NfmEditorContextMenuItem>
      ) : null}
      <NfmEditorContextMenuItem
        leftSlot={<PageMenuCopyLinkIcon />}
        onSelect={() => {
          const request = resolvePageCopyRequest({
            actionId: "copy-deeplink",
            page: { routingContext, pageId: target.pageId, pageKey: null },
            presentedTitle: page?.title ?? "",
          });
          if (request?.kind !== "value") return;
          void copyTextWithFeedback(request.value, request.successMessage, request.failureMessage);
        }}
      >
        <FormattedMessage id="lib.pageCopyModel.copyDeeplink" defaultMessage="Copy link" />
      </NfmEditorContextMenuItem>
      <NodexDropdownSeparator />
    </>
  );
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

function NfmEditorContextMenuContent({
  selectionEmpty,
  editable,
  onCommand,
}: NfmEditorContextMenuContentProps) {
  return (
    <>
      <NfmEditorContextMenuItem
        disabled={!editable || selectionEmpty}
        leftSlot={<Scissors />}
        onSelect={() => onCommand("cut")}
        shortcut={formatAcceleratorLabel("CmdOrCtrl+X", resolveCodexRendererCommandPlatform())}
      >
        <FormattedMessage id="editor.nfmEditorContextMenu.cut" defaultMessage="Cut" />
      </NfmEditorContextMenuItem>
      <NfmEditorContextMenuItem
        disabled={selectionEmpty}
        leftSlot={<CopyIcon />}
        onSelect={() => onCommand("copy")}
        shortcut={formatAcceleratorLabel("CmdOrCtrl+C", resolveCodexRendererCommandPlatform())}
      >
        <FormattedMessage id="editor.nfmEditorContextMenu.copy" defaultMessage="Copy" />
      </NfmEditorContextMenuItem>
      <NfmEditorContextMenuItem
        disabled={!editable}
        leftSlot={<Clipboard />}
        onSelect={() => onCommand("paste")}
        shortcut={formatAcceleratorLabel("CmdOrCtrl+V", resolveCodexRendererCommandPlatform())}
      >
        <FormattedMessage id="editor.nfmEditorContextMenu.paste" defaultMessage="Paste" />
      </NfmEditorContextMenuItem>
    </>
  );
}

function NfmEditorContextMenuItem({
  children,
  shortcut,
  className,
  ...props
}: NodexContextMenuItemProps & {
  shortcut?: string;
}) {
  return (
    <NodexContextMenuItem
      className={cn(MENU_ITEM_CLASS_NAME, "flex items-center gap-6", className)}
      rightSlot={shortcut ? <span className={SHORTCUT_CLASS_NAME}>{shortcut}</span> : undefined}
      {...props}
    >
      {children}
    </NodexContextMenuItem>
  );
}

export function NfmEditorContextMenu({
  editor,
  children,
  onPreparePaste,
}: NfmEditorContextMenuProps) {
  const [selectionEmpty, setSelectionEmpty] = useState(true);
  const [editable, setEditable] = useState(true);
  const [mentionTarget, setMentionTarget] = useState<PageMentionContextTarget | null>(null);
  const pendingMentionTargetRef = useRef<PageMentionContextTarget | null>(null);
  const highlightedChipRef = useRef<HTMLElement | null>(null);

  const handleContextMenuCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!isEventWithinCurrentTarget(event)) return;
      pendingMentionTargetRef.current = resolvePageMentionContextTarget(editor, event.target);
    },
    [editor],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      const nextMentionTarget = open ? pendingMentionTargetRef.current : null;
      pendingMentionTargetRef.current = null;
      setPageMentionContextHighlight(highlightedChipRef.current, false);
      highlightedChipRef.current = nextMentionTarget?.chip ?? null;
      setPageMentionContextHighlight(highlightedChipRef.current, true);
      setMentionTarget(nextMentionTarget);
      if (!open) return;
      setSelectionEmpty(getSelectionEmpty(editor));
      setEditable(getIsEditable(editor));
    },
    [editor],
  );

  const handleTurnIntoEmbed = useCallback(() => {
    if (!mentionTarget) return;
    if (turnPageMentionIntoEmbed(editor, mentionTarget)) return;
    toast.info(
      getIntl().formatMessage({
        id: "editor.nfmEditorContextMenu.couldNotTurnIntoEmbed",
        defaultMessage: "The mention changed before it could become an embed.",
      }),
    );
  }, [editor, mentionTarget]);

  const handleCommand = useCallback(
    (command: NfmEditorCommand) => {
      void runNfmEditorContextCommand(editor, command, undefined, onPreparePaste)
        .then((handled) => {
          if (command === "paste" && !handled)
            toast.info(
              getIntl().formatMessage({
                id: "editor.nfmEditorContextMenu.couldNotPaste",
                defaultMessage: "Couldn’t paste at the original position. Try again.",
              }),
            );
        })
        .catch(() =>
          toast.danger(
            getIntl().formatMessage({
              id: "editor.nfmEditorContextMenu.clipboardFailed",
              defaultMessage: "Couldn’t complete the clipboard action. Try again.",
            }),
          ),
        );
    },
    [editor, onPreparePaste],
  );

  const content = useMemo(
    () => (
      <>
        {mentionTarget ? (
          <NfmPageMentionContextMenuItems
            target={mentionTarget}
            editable={editable}
            onTurnIntoEmbed={handleTurnIntoEmbed}
          />
        ) : null}
        <NfmEditorContextMenuContent
          selectionEmpty={selectionEmpty}
          editable={editable}
          onCommand={handleCommand}
        />
      </>
    ),
    [editable, handleCommand, handleTurnIntoEmbed, mentionTarget, selectionEmpty],
  );

  return (
    <NodexContextMenuRoot onOpenChange={handleOpenChange}>
      <NodexContextMenuTrigger>
        <div className="contents" onContextMenuCapture={handleContextMenuCapture}>
          {children}
        </div>
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
