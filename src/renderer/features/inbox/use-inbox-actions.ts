import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  InboxChat,
  InboxConfirmationDraft,
  InboxDispatchAction,
  InboxEntryKind,
  InboxPageBasis,
  InboxProposal,
  InboxPreparedConfirmation,
  InboxScope,
  InboxSendInput,
  InboxSendResult,
  InboxItem,
} from "../../../shared/inbox";
import type { Project } from "../../../shared/types";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { toast } from "@/components/ui/toast";
import {
  confirmInboxDispatch,
  deleteInboxMessages,
  dispatchInboxEntries,
  editInboxMessage,
  keepInboxEntries,
  prepareInboxConfirmation,
  requestInboxSuggestion,
  retryInboxDispatch,
  setInboxEntryImportant,
  setInboxEntryKind,
  markInboxMessagesDone,
  returnInboxMessages,
  setInboxLater,
  clearInboxLater,
  stopInboxSuggestion,
  undoInboxDecision,
} from "@/lib/inbox-runtime";
import { CoreApiError } from "@/lib/core-api-error";
import { readableIpcError } from "@/lib/ipc-error-message";
import { RendererCommandRejectedError } from "@/lib/renderer-command";
import { inboxReceiptNeedsReview, type InboxDecision } from "./inbox-presentation";
import { describeLaterConfirmation } from "./inbox-later";
import { invalidateInbox } from "./use-inbox";
import { useInboxCaptureState } from "./use-inbox-capture";
import { useSendInboxMessage } from "./use-send-inbox-message";

export { useSendInboxMessage };

export interface InboxActions {
  readonly send: (intent: InboxSendInput) => Promise<InboxSendResult>;
  readonly pendingDecisions: readonly {
    readonly key: string;
    readonly prepared: InboxPreparedConfirmation;
  }[];
  readonly retryDecision: (key: string) => Promise<boolean>;
  readonly forgetDecision: (key: string) => Promise<boolean>;
  readonly edit: (
    pageId: string,
    originalBody: string,
    body: string,
    basis: InboxPageBasis,
  ) => Promise<boolean>;
  /** `chat` is the chat an edited action sends to, when the editor knows it. */
  readonly confirm: (
    proposal: InboxProposal,
    edited?: InboxDispatchAction,
    chat?: InboxChat | null,
    droppedSkillNames?: readonly string[],
  ) => Promise<boolean>;
  readonly dispatch: (
    pageIds: readonly string[],
    action: InboxDispatchAction,
    basis: readonly InboxPageBasis[],
    chat?: InboxChat | null,
  ) => Promise<boolean>;
  /** Holds messages as work: their Pages move to Todo. */
  readonly keep: (pageIds: readonly string[]) => Promise<boolean>;
  /** Holds messages as notes: their Pages move under the Inbox's Notes page, off the Board. */
  readonly saveToNotes: (
    pageIds: readonly string[],
    basis: readonly InboxPageBasis[],
  ) => Promise<boolean>;
  /**
   * Sets messages aside until `remindAt`. `reschedule` changes
   * when messages already set aside come back, which is not a new decision to undo.
   */
  readonly later: (
    pageIds: readonly string[],
    remindAt: string,
    reschedule?: boolean,
  ) => Promise<boolean>;
  readonly clearLater: (pageIds: readonly string[]) => Promise<boolean>;
  readonly delete: (pageIds: readonly string[]) => Promise<boolean>;
  readonly setState: (pageIds: readonly string[], action: "done" | "open") => Promise<boolean>;
  readonly setKind: (pageId: string, kind: InboxEntryKind | null) => Promise<boolean>;
  readonly setImportant: (pageId: string, important: boolean) => Promise<boolean>;
  readonly requestSuggestion: (
    pageIds: readonly string[],
    basis: readonly InboxPageBasis[],
    refine?: { readonly proposal: InboxProposal; readonly correction: string },
  ) => Promise<boolean>;
  readonly stopSuggestion: (pageId: string) => Promise<boolean>;
  readonly retryDispatch: (proposalId: string) => Promise<boolean>;
}

const clearedLabel = (outcome: "kept" | "done", count: number): string => {
  if (outcome === "kept") return count > 1 ? `Added ${count} messages to Todo` : "Added to Todo";
  return count > 1 ? `Marked ${count} messages done` : "Marked done";
};

/**
 * Decisions keep their prepared identity across transport failure and renderer restart.
 * `onDecided` hears each decision once Core has accepted it.
 */
export function useInboxActions(
  projects: readonly Project[],
  scope: InboxScope,
  windowSessionId: string,
  storeEpoch: string | null,
  visibleItems: readonly InboxItem[],
  onDecided: (pageIds: readonly string[], decision: InboxDecision) => void = () => {},
): InboxActions {
  const queryClient = useQueryClient();
  const send = useSendInboxMessage();
  const local = useInboxCaptureState(windowSessionId, scope);
  const deciding = useRef(
    new Map<string, { readonly draft: InboxConfirmationDraft; readonly promise: Promise<void> }>(),
  );
  const [activeDecisions, setActiveDecisions] = useState<readonly string[]>([]);
  const decisions = local.state.value.decisions;
  const write = local.write;
  useLayoutEffect(() => {
    const observed = new Set(
      visibleItems.flatMap((item) =>
        item.proposal && item.proposal.state !== "open" ? [item.proposal.proposalId] : [],
      ),
    );
    if (
      !Object.values(decisions).some(
        (decision) => decision.storeEpoch === storeEpoch && observed.has(decision.proposalId),
      )
    )
      return;
    void write((state) => ({
      ...state,
      decisions: Object.fromEntries(
        Object.entries(state.decisions).filter(
          ([, decision]) =>
            decision.storeEpoch !== storeEpoch || !observed.has(decision.proposalId),
        ),
      ),
    })).catch(() => undefined);
  }, [decisions, visibleItems, storeEpoch, write]);
  const run = async (fallback: string, task: () => Promise<unknown>): Promise<boolean> => {
    return runWithCleanup(
      async () => {
        await task();
        return true;
      },
      {
        onError: (error) => {
          toast.danger(readableIpcError(error, fallback));
          return false;
        },
        cleanup: () => {
          void invalidateInbox(queryClient);
        },
      },
    );
  };

  const announceCleared = (
    outcome: "kept" | "done",
    pageIds: readonly string[],
    undoToken: string | null,
  ) =>
    toast.success(
      clearedLabel(outcome, pageIds.length),
      undoToken
        ? {
            action: {
              label: "Undo",
              onClick: () => {
                void run("The message could not be restored", () =>
                  undoInboxDecision({ operationId: createUuidV7(), undoToken }),
                );
              },
            },
          }
        : undefined,
    );

  const clearLater = (pageIds: readonly string[]) =>
    run("The message could not be returned", () => clearInboxLater({ pageIds }));

  const announceLater = (pageIds: readonly string[], remindAt: string, undo: boolean) =>
    toast.success(
      describeLaterConfirmation(remindAt, pageIds.length, new Date()),
      undo ? { action: { label: "Undo", onClick: () => void clearLater(pageIds) } } : undefined,
    );

  const submitPrepared = (prepared: InboxPreparedConfirmation) => {
    if (prepared.kind === "proposal") {
      const { kind: _kind, ...input } = prepared;
      return confirmInboxDispatch(input);
    }
    const { kind: _kind, ...input } = prepared;
    return dispatchInboxEntries(input);
  };

  const projectName = (projectId: string | null) =>
    projects.find((project) => project.id === projectId)?.name ?? null;
  const decisionOf = (
    action: InboxDispatchAction,
    sessionId: string,
    chat: InboxChat | null,
  ): InboxDecision => {
    switch (action.type) {
      case "plan":
        return { kind: "plan", count: action.steps.length };
      case "later":
        return { kind: "later", remindAt: action.remindAt };
      case "keep":
        return { kind: "keep" };
      case "save_to_notes":
        return { kind: "save_to_notes" };
      case "move_to_project":
        return { kind: "move", projectName: projectName(action.projectId) };
      case "new_chat":
        return {
          kind: "chat",
          type: "new_chat",
          sessionId,
          chatTitle: null,
          projectName: projectName(action.projectId),
        };
      case "send_to_chat":
        return {
          kind: "chat",
          type: "send_to_chat",
          sessionId: action.sessionId,
          chatTitle: chat?.sessionId === action.sessionId ? chat.displayTitle : null,
          projectName: null,
        };
      case "execute_decision": {
        const source = visibleItems.find(
          (item) => item.automationDecision?.dispatchId === action.decisionId,
        )?.source;
        return {
          kind: "run",
          taskName: source?.kind === "automation" ? source.label : "automation",
        };
      }
    }
  };

  const performDecision = async (
    draft: InboxConfirmationDraft,
    key: string,
    chat: InboxChat | null,
  ) => {
    return runWithCleanup(
      async () => {
        const prepared = local.read().decisions[key] ?? (await prepareInboxConfirmation(draft));
        await local.write((state) => ({
          ...state,
          decisions: { ...state.decisions, [key]: prepared },
        }));
        const result = await submitPrepared(prepared);
        await local.write((state) => ({
          ...state,
          decisions: Object.fromEntries(
            Object.entries(state.decisions).filter(([id]) => id !== key),
          ),
        }));
        const action = draft.action;
        if (action) {
          onDecided(
            draft.basis.map((basis) => basis.pageId),
            decisionOf(action, prepared.sessionId, chat),
          );
        }
        if (
          result.value.undoToken &&
          (action?.type === "move_to_project" || action?.type === "save_to_notes")
        ) {
          const undoToken = result.value.undoToken;
          const operationId = createBoundedOperationId("inbox.undo");
          toast.success(
            action?.type === "move_to_project"
              ? `Moved to ${projects.find((project) => project.id === action.projectId)?.name ?? "Project"}`
              : "Saved to Notes",
            {
              action: {
                label: "Undo",
                onClick: () => {
                  void run("The move could not be undone", () =>
                    undoInboxDecision({ operationId, undoToken }),
                  );
                },
              },
            },
          );
        } else if (action?.type === "keep")
          announceCleared(
            "kept",
            draft.basis.map((basis) => basis.pageId),
            result.value.undoToken,
          );
        else if (action?.type === "later")
          announceLater(
            draft.basis.map((basis) => basis.pageId),
            action.remindAt,
            true,
          );
      },
      {
        onError: async (error) => {
          if (inboxReceiptNeedsReview(error))
            throw new Error(
              "This handoff could not be verified. Check the destination before deciding again.",
              { cause: error },
            );
          if (error instanceof RendererCommandRejectedError || error instanceof CoreApiError) {
            await local
              .write((state) => ({
                ...state,
                decisions: Object.fromEntries(
                  Object.entries(state.decisions).filter(([id]) => id !== key),
                ),
              }))
              .catch(() => undefined);
          }
          throw error;
        },
      },
    );
  };

  const decide = (
    draft: InboxConfirmationDraft,
    key = JSON.stringify(draft),
    chat: InboxChat | null = null,
  ): Promise<void> => {
    if (local.state.status !== "ready")
      return Promise.reject(
        new Error("Saved decisions are not available yet. Retry after loading."),
      );
    if (!storeEpoch || draft.storeEpoch !== storeEpoch)
      return Promise.reject(
        new Error(
          "This handoff is from before a Profile restore. Review the current message before trying again.",
        ),
      );
    const pending = deciding.current.get(key);
    if (pending) return pending.promise;
    const requestedPages = new Set(draft.basis.map((basis) => basis.pageId));
    if (
      [...deciding.current.values()].some(({ draft: active }) =>
        active.basis.some((basis) => requestedPages.has(basis.pageId)),
      ) ||
      Object.entries(local.read().decisions).some(
        ([savedKey, saved]) =>
          savedKey !== key && saved.basis.some((basis) => requestedPages.has(basis.pageId)),
      )
    )
      return Promise.reject(
        new Error("A previous handoff is still unconfirmed. Check it before starting another."),
      );
    setActiveDecisions((current) => [...current, key]);
    const submission = performDecision(draft, key, chat).finally(() => {
      deciding.current.delete(key);
      setActiveDecisions((current) => current.filter((active) => active !== key));
    });
    deciding.current.set(key, { draft, promise: submission });
    return submission;
  };

  return {
    pendingDecisions: Object.entries(decisions).flatMap(([key, prepared]) =>
      activeDecisions.includes(key) ? [] : [{ key, prepared }],
    ),
    retryDecision: (key) =>
      run("The handoff could not be confirmed", async () => {
        const prepared = local.read().decisions[key];
        if (prepared) await decide(prepared, key);
      }),
    forgetDecision: (key) =>
      run("The saved handoff could not be cleared", () =>
        local.write((state) => ({
          ...state,
          decisions: Object.fromEntries(
            Object.entries(state.decisions).filter(([savedKey]) => savedKey !== key),
          ),
        })),
      ),
    send,
    edit: (pageId, originalBody, body, basis) =>
      run("The message could not be edited", () =>
        editInboxMessage({ pageId, basis, originalBody, body }),
      ),
    confirm: (proposal, edited, chat, droppedSkillNames) =>
      run("The suggestion could not be confirmed", () => {
        const draft: InboxConfirmationDraft = {
          kind: "proposal",
          storeEpoch: storeEpoch ?? "",
          proposalId: proposal.proposalId,
          expectedRevision: proposal.revision,
          basis: proposal.basis,
          action: edited ?? proposal.action,
          ...(droppedSkillNames ? { droppedSkillNames } : {}),
        };
        return decide(draft, undefined, chat ?? proposal.chat);
      }),
    dispatch: (pageIds, action, basis, chat) =>
      run("The message could not be dispatched", () =>
        decide(
          { kind: "direct", storeEpoch: storeEpoch ?? "", pageIds, action, basis },
          undefined,
          chat ?? null,
        ),
      ),
    saveToNotes: (pageIds, basis) =>
      run("The message could not be saved to Notes", () =>
        decide({
          kind: "direct",
          storeEpoch: storeEpoch ?? "",
          pageIds,
          action: { type: "save_to_notes", parentPageId: null },
          basis,
        }),
      ),
    keep: (pageIds) =>
      run("The message could not be added to Todo", async () => {
        const {
          value: { undoToken },
        } = await keepInboxEntries({ pageIds });
        onDecided(pageIds, { kind: "keep" });
        announceCleared("kept", pageIds, undoToken);
      }),
    later: (pageIds, remindAt, reschedule = false) =>
      run("The message could not be set aside", async () => {
        await setInboxLater({ pageIds, until: remindAt });
        if (!reschedule) onDecided(pageIds, { kind: "later", remindAt });
        announceLater(pageIds, remindAt, !reschedule);
      }),
    clearLater,
    delete: (pageIds) =>
      run("The message could not be deleted", async () => {
        await deleteInboxMessages({ pageIds });
        const deleted = new Set(pageIds);
        await local.write((state) => ({
          ...state,
          captures: state.captures.filter((capture) => !deleted.has(capture.intent.pageId)),
          decisions: Object.fromEntries(
            Object.entries(state.decisions).filter(
              ([, decision]) => !decision.basis.some((basis) => deleted.has(basis.pageId)),
            ),
          ),
        }));
        toast.success(pageIds.length > 1 ? `Deleted ${pageIds.length} messages` : "Deleted");
      }),
    setState: (pageIds, state) =>
      run("The message could not be updated", async () => {
        if (state === "open") {
          await returnInboxMessages({ pageIds });
          return;
        }
        const {
          value: { undoToken },
        } = await markInboxMessagesDone({ pageIds });
        onDecided(pageIds, { kind: "done" });
        announceCleared("done", pageIds, undoToken);
      }),
    setKind: (pageId, kind) =>
      run("The message could not be updated", () => setInboxEntryKind({ pageId, kind })),
    setImportant: (pageId, important) =>
      run("The message could not be updated", () => setInboxEntryImportant({ pageId, important })),
    requestSuggestion: (pageIds, basis, refine) =>
      run("A new suggestion could not be requested", () =>
        requestInboxSuggestion({
          requestId: createUuidV7(),
          mode: refine ? "refine" : pageIds.length > 1 ? "grouped" : "auto",
          pageIds,
          basis,
          ...(refine
            ? {
                proposalId: refine.proposal.proposalId,
                expectedRevision: refine.proposal.revision,
                correction: refine.correction,
              }
            : {}),
        }),
      ),
    stopSuggestion: (pageId) =>
      run("The suggestion could not be stopped", () => stopInboxSuggestion({ pageId })),
    retryDispatch: (proposalId) =>
      run("The dispatch could not be retried", () => retryInboxDispatch({ proposalId })),
  };
}
