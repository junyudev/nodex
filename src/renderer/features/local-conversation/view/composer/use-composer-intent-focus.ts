import { useLayoutEffect, type RefObject } from "react";
import {
  composerDraftIntents,
  hasOpenComposerBlockingDialog,
  type ComposerChatKey,
} from "@/lib/composer-draft-intents";
import type { CodexComposerIntent } from "../../../../../shared/types";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";

export function useComposerIntentFocus({
  chat,
  intent,
  editorRef,
  visible,
  disabled,
  conversationReady,
  onSettled,
}: {
  chat: ComposerChatKey | null | undefined;
  intent: CodexComposerIntent | null;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
  visible: boolean;
  disabled: boolean;
  conversationReady: boolean;
  onSettled: (intent: CodexComposerIntent) => void;
}) {
  useLayoutEffect(() => {
    if (!intent || !visible || disabled) return;
    const editor = editorRef.current;
    const element = editor?.getElement();
    if (!editor || !element) return;
    const document = element.ownerDocument;

    const attempt = (): boolean => {
      const focus = chat
        ? composerDraftIntents.focusFor(chat, intent, element, conversationReady)
        : null;
      if (focus?.status === "superseded" || focus?.status === "waiting") return true;
      if (focus?.status === "abandoned") {
        onSettled(intent);
        return true;
      }
      if (
        !element.isConnected ||
        element.closest('[hidden], [aria-hidden="true"], [inert], [data-base-ui-inert]') ||
        element.checkVisibility?.({ visibilityProperty: true }) === false ||
        hasOpenComposerBlockingDialog(document)
      ) {
        return false;
      }
      if (document.activeElement !== element) editor.focus();
      if (document.activeElement !== element) return false;
      editor.focusAtSelection(focus?.selection);
      onSettled(intent);
      return true;
    };

    if (attempt()) return;
    // An offscreen route or a closing modal can become focusable without a composer render.
    const observer = new MutationObserver(() => {
      if (attempt()) observer.disconnect();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "hidden", "inert", "data-base-ui-inert", "class", "style"],
    });
    return () => observer.disconnect();
  }, [chat, conversationReady, disabled, editorRef, intent, onSettled, visible]);
}
