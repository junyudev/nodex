import { useCallback, useEffect, useRef } from "react";
import { SideChatCloseDialog } from "@/components/workbench/side-chat-close-dialog";
import { appScope, useScopeHandle } from "./maitai";
import { closeModal, openModal } from "./modal-registry";
import { readLocalConversation } from "@/features/local-conversation/local-conversation-store";
import type { SideChatPanelTab } from "./workbench-panel-tab-model";

const SKIP_CONFIRMATION_KEY = "nodex-skip-side-chat-close-confirmation-v1";

/** Native remote side chats are temporary; Runtime side chats never need close confirmation. */
export function useSideChatCloseConfirmation() {
  const appHandle = useScopeHandle(appScope);
  const pending = useRef<{ promise: Promise<boolean>; resolve: (value: boolean) => void } | null>(
    null,
  );
  useEffect(
    () => () => {
      pending.current?.resolve(false);
      pending.current = null;
      closeModal(appHandle, SideChatCloseDialog);
    },
    [appHandle],
  );
  return useCallback(
    async (tab: SideChatPanelTab) => {
      if (!tab.threadId) return true;
      if (!(readLocalConversation(tab.threadId)?.turns.length ?? 0)) return true;
      try {
        if (localStorage.getItem(SKIP_CONFIRMATION_KEY) === "true") return Promise.resolve(true);
      } catch {
        /* An unavailable preference store still allows confirmation. */
      }
      if (pending.current) return pending.current.promise;
      let settle!: (value: boolean) => void;
      const promise = new Promise<boolean>((resolve) => {
        settle = (value) => {
          pending.current = null;
          resolve(value);
        };
        openModal(appHandle, SideChatCloseDialog, {
          onClose: () => settle(false),
          onConfirm: (skip) => {
            if (skip) {
              try {
                localStorage.setItem(SKIP_CONFIRMATION_KEY, "true");
              } catch {
                /* Keep this close available. */
              }
            }
            settle(true);
          },
        });
      });
      pending.current = { promise, resolve: settle };
      return promise;
    },
    [appHandle],
  );
}
