import { AgentQuestionIcon } from "@/components/shared/icons";
import { useCodexServiceTierSettings } from "@/lib/use-codex-service-tier-settings";
import type { ThreadFooterModel } from "../../thread-stage-types";
import { useSyncExternalStore, type ReactNode } from "react";
import { useCodexAppServerManagerForConversationId } from "../../local-conversation-store";
import { AsyncQuestionPanel } from "./async-question-panel";
import { CodexShimmerText } from "../shared/codex-shimmer-text";
export function useAsyncQuestions(threadId: string) {
  const manager = useCodexAppServerManagerForConversationId(threadId);
  const runtime = manager.asyncQuestions;
  const state = useSyncExternalStore(runtime.subscribe, () => runtime.read(threadId));
  return { manager, runtime, state };
}

export function AsyncQuestionComposer({
  threadId,
  model,
}: {
  threadId: string;
  model: ThreadFooterModel;
}) {
  const { manager, runtime, state } = useAsyncQuestions(threadId);
  const { serviceTierSettings } = useCodexServiceTierSettings();
  return (
    <AsyncQuestionPanel
      threadId={threadId}
      runtime={runtime}
      state={state}
      mentionContext={{
        workspaceRoot: model.cwd ?? model.projectWorkspacePath ?? null,
        skills: model.composerSkills ?? [],
        apps: model.composerApps ?? [],
      }}
      onSend={async () => {
        await runtime.submit(threadId, async (turnId, prompt) => {
          const conversation = manager.readConversation(threadId);
          if (
            !conversation?.turns.some(
              (turn) => turn.turnId === turnId && turn.status === "inProgress",
            )
          )
            return null;
          return await manager.steerTurn({
            threadId,
            expectedTurnId: turnId,
            prompt,
            serviceTier: serviceTierSettings.serviceTier,
            collaborationMode: model.selectedCollaborationMode,
          });
        });
      }}
    />
  );
}

export function AsyncQuestionTranscript({
  threadId,
  questionId,
  children,
}: {
  threadId: string;
  questionId: string;
  children: ReactNode;
}) {
  const { runtime, state } = useAsyncQuestions(threadId);
  const question = state.questions[questionId];
  const live = question?.turnId === state.activeTurnId;
  const asking = live && state.openedAutomatically && state.openIds[0] === questionId;
  if (asking)
    return (
      <CodexShimmerText active variant="classic" className="text-sm text-token-text-secondary">
        {state.openIds.length > 1 ? "Asking questions" : "Asking question"}
      </CodexShimmerText>
    );
  return (
    <div className="flex flex-col items-start gap-3">
      {children}
      {live && !question?.baseline && state.selectedId !== questionId ? (
        <button
          type="button"
          onClick={() => runtime.open(threadId, questionId)}
          className="inline-flex items-center gap-2 rounded-full border border-default px-3 py-1 text-sm hover:bg-text/5"
        >
          <AgentQuestionIcon />
          Answer question
        </button>
      ) : null}
    </div>
  );
}
