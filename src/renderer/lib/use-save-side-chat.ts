import { useCallback } from "react";
import { toast } from "../components/ui/toast";
import { acquireComposerDraftCapture } from "../features/local-conversation/view/composer/composer-draft-capture";
import { publishComposerDraftTransfer } from "../features/local-conversation/view/composer/composer-draft-state";
import { appScope, useScopeHandle } from "./maitai";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { sideChatSaveStore } from "./side-chat-save";
import type { SideChatPanelTab } from "./workbench-panel-tab-model";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import type { ExecuteWorkbenchUiCommand } from "./use-workbench-scene-commands";
import type { useWorkbenchSessionCommands } from "./use-workbench-session-commands";
import type { AgentRuntimeSessionTarget } from "../../shared/agent-runtime-api";

const readConversationHead = async (target: AgentRuntimeSessionTarget) => {
  // Save results also carry Project/provenance fields; control accepts only the addressed target.
  const { projection } = (
    await agentRuntimeRuntime.control({
      sessionId: target.sessionId,
      ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    })
  ).snapshot;
  return JSON.stringify({
    run: projection.runs.at(-1)?.id,
    revision: projection.thread.historyRevision,
    sideChat: projection.thread.sideChat,
    selection: projection.thread.modelSelection,
    mode: projection.thread.interactionMode,
    cwd: projection.thread.worktreePath,
  });
};

export function useSaveSideChat(input: {
  readonly owner: WorkbenchWindowOwner;
  readonly refresh: (projectId: string | null) => Promise<unknown>;
  readonly open: ReturnType<typeof useWorkbenchSessionCommands>["openAttachedThreadSessionById"];
  readonly execute: ExecuteWorkbenchUiCommand;
}) {
  const app = useScopeHandle(appScope);
  const { owner, refresh, open, execute } = input;
  return useCallback(
    async (tab: SideChatPanelTab) => {
      if (!tab.runtimeSession || !tab.threadId || tab.status !== "ready") return;
      const source = { sessionId: tab.runtimeSession.id, threadId: tab.threadId };
      const location = JSON.stringify(owner.read().windowState.location);
      const isSourceCurrent = () => {
        const state = owner.read();
        return (
          JSON.stringify(state.windowState.location) === location &&
          Boolean(
            state.ephemeralPanels.sideChatTabsBySession[tab.sessionId]?.some(
              (candidate) =>
                candidate.id === tab.id && candidate.runtimeSession?.id === source.sessionId,
            ),
          )
        );
      };
      try {
        await sideChatSaveStore.save({
          ...source,
          tabId: tab.id,
          isSourceCurrent,
          acquireDraft: () => {
            const result = acquireComposerDraftCapture({
              threadId: source.threadId,
              composerScopeIdentity: `side-chat-session:${source.sessionId}`,
            });
            if (result.status !== "ready") throw new Error(result.message);
            return result.lease;
          },
          readSourceHead: () => readConversationHead(source),
          readSavedHead: readConversationHead,
          save: agentRuntimeRuntime.saveSideChat,
          refresh,
          publishDraft: (transfer) => publishComposerDraftTransfer(app, transfer),
          open: (saved, current) =>
            open(saved.threadId, {
              runtimeSessionId: saved.sessionId,
              isSourceCurrent: current,
            }),
          close: async () => {
            const receipt = await execute(
              { kind: "session", sessionId: tab.sessionId },
              {
                kind: "close_tab",
                tabId: tab.id,
              },
            );
            if (receipt.error && receipt.error !== "tab_not_found")
              throw new Error("The chat was saved, but the side panel could not be closed.");
            if (!receipt.applied && receipt.error !== "tab_not_found")
              throw new Error("The chat was saved. Close its temporary side panel when ready.");
          },
        });
      } catch (cause) {
        toast.danger(cause instanceof Error ? cause.message : "The side chat could not be saved.", {
          id: `save-side-chat:${source.sessionId}`,
        });
      }
    },
    [app, owner, refresh, open, execute],
  );
}
