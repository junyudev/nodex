import { useBlockNoteEditor } from "@blocknote/react";
import { useEffect, useLayoutEffect, useRef } from "react";
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

function isMacPlatform() {
  return typeof navigator !== "undefined" && /mac/iu.test(navigator.platform);
}

/**
 * `⌘⇧↵` sends the selection to the chat this Page is shown beside, or opens Send to chat when
 * there is no such chat; with a bare caret it sends the Prompt holding it. `⌥⌘↵` adds the
 * selection to that chat's composer instead.
 */
export function NfmChatSendShortcutController() {
  const editor = useBlockNoteEditor() as unknown as ChatShortcutEditor;
  const runtime = useNfmTextActionMenuRuntime();
  const sideMenu = useNfmSideMenuOpenController();
  const prompts = useNfmPromptRuntime();
  const latestRef = useRef({ runtime, sideMenu, prompts });
  useLayoutEffect(() => {
    latestRef.current = { runtime, sideMenu, prompts };
  }, [prompts, runtime, sideMenu]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = resolveNfmChatSendShortcut(event, isMacPlatform());
      if (!shortcut) return;
      const editorRoot = editor.domElement;
      if (!editorRoot || !(event.target instanceof Node) || !editorRoot.contains(event.target))
        return;
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
