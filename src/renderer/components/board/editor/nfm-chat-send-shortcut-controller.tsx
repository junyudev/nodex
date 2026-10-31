import { useBlockNoteEditor } from "@blocknote/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useResolvedCommandKeymapState } from "@/lib/use-command-keymap-state";
import { getNfmBlockSelectionIds } from "./nfm-block-selection";
import { resolveNfmChatSendShortcut } from "./nfm-chat-send-shortcuts";
import { reportNfmChatSendFailure } from "./nfm-chat-send-feedback";
import { resolveNfmSendToThreadPreferredDestination } from "./nfm-send-to-thread-menu-model";
import { useNfmSideMenuOpenController } from "./nfm-side-menu";
import { useNfmTextActionMenuRuntime } from "./nfm-text-action-menu-runtime";
import { findNfmPromptBlockAtCaret } from "./nfm-prompt-block-model";
import { useNfmPromptRuntime } from "./nfm-prompt-runtime";

interface ChatShortcutEditor {
  readonly domElement?: HTMLElement | null;
  readonly prosemirrorView?: { readonly state: { readonly selection: unknown } } | null;
  getSelection?: () => { blocks: readonly { id?: unknown }[] } | undefined;
}

/** The Blocks an expanded selection covers; a bare caret names none. */
function resolveSelectedBlockIds(editor: ChatShortcutEditor): string[] {
  const selection = editor.prosemirrorView?.state.selection;
  const blockSelectionIds = selection
    ? getNfmBlockSelectionIds(selection as Parameters<typeof getNfmBlockSelectionIds>[0])
    : [];
  if (blockSelectionIds.length > 0) return blockSelectionIds;
  return (editor.getSelection?.()?.blocks ?? []).flatMap((block) =>
    typeof block.id === "string" ? [block.id] : [],
  );
}

/**
 * Send targets the chat beside the Page, or opens its picker; a bare caret targets its
 * containing Prompt. Add to composer hands the selection to the beside chat's draft.
 */
export function NfmChatSendShortcutController() {
  const editor = useBlockNoteEditor() as unknown as ChatShortcutEditor;
  const runtime = useNfmTextActionMenuRuntime();
  const sideMenu = useNfmSideMenuOpenController();
  const prompts = useNfmPromptRuntime();
  const keymap = useResolvedCommandKeymapState();
  const latestRef = useRef({ runtime, sideMenu, prompts, keymap });
  useLayoutEffect(() => {
    latestRef.current = { runtime, sideMenu, prompts, keymap };
  }, [prompts, runtime, sideMenu, keymap]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const editorRoot = editor.domElement;
      if (!editorRoot || !(event.target instanceof Node) || !editorRoot.contains(event.target))
        return;
      const shortcut = resolveNfmChatSendShortcut(event, latestRef.current.keymap);
      if (!shortcut) return;
      const {
        runtime: currentRuntime,
        sideMenu: currentSideMenu,
        prompts: currentPrompts,
      } = latestRef.current;
      const blockIds = resolveSelectedBlockIds(editor);
      if (blockIds.length === 0) {
        const promptBlockId =
          shortcut === "send" && currentPrompts.destination
            ? findNfmPromptBlockAtCaret(
                editor as unknown as Parameters<typeof findNfmPromptBlockAtCaret>[0],
              )
            : null;
        if (!promptBlockId) return;
        event.preventDefault();
        event.stopPropagation();
        void currentPrompts
          .send(promptBlockId)
          .catch((error: unknown) => reportNfmChatSendFailure("send", error));
        return;
      }
      const chat = currentRuntime.chat;
      if (!chat) return;

      if (shortcut === "add-to-composer") {
        const addToComposer = chat.addToComposer;
        if (!addToComposer) return;
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve(addToComposer(blockIds)).catch((error: unknown) =>
          reportNfmChatSendFailure("add-to-composer", error),
        );
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (!chat.contextualTarget) {
        currentSideMenu.openForCurrentSelection({
          returnFocusElement: editorRoot,
          initialSubmenu: "send-to-thread",
        });
        return;
      }
      void Promise.resolve(
        chat.send(
          { target: resolveNfmSendToThreadPreferredDestination(chat.contextualTarget) },
          blockIds,
        ),
      ).catch((error: unknown) => reportNfmChatSendFailure("send", error));
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [editor]);

  return null;
}
