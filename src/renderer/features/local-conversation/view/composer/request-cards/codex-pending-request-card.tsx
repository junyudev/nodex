import type {
  ThreadComposerShellPendingRequestModel,
  ThreadStageActions,
} from "../../../thread-stage-types";
import { CodexImplementPlanRequestCard } from "./codex-implement-plan-request-card";
import { CodexMcpElicitationRequestCard } from "./codex-mcp-elicitation-request-card";
import { CodexOptionPickerRequestCard } from "./codex-option-picker-request-card";
import { CodexSetupCodexStepRequestCard } from "./codex-setup-codex-step-request-card";
import { CodexUserInputRequestCard } from "./codex-user-input-request-card";
import type { ComposerIntelligenceController } from "../use-composer-intelligence-controller";
import { buildComposerIntelligenceTurnOverrides } from "../composer-intelligence-selection";
import { bindPendingRequestConversationActions } from "./pending-request-conversation-actions";

interface CodexPendingRequestCardProps {
  entry: ThreadComposerShellPendingRequestModel;
  actions: ThreadStageActions;
  intelligenceController?: ComposerIntelligenceController;
}

const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:";

export function CodexPendingRequestCard({
  entry,
  actions,
  intelligenceController,
}: CodexPendingRequestCardProps) {
  const conversationActions = bindPendingRequestConversationActions({
    actions,
    conversationId: entry.conversationId,
  });
  switch (entry.request.type) {
    case "userInput":
      return (
        <CodexUserInputRequestCard
          conversationId={entry.conversationId}
          request={entry.request}
          onInterrupt={async () => {
            if (entry.request.turnId === null) {
              await conversationActions.respondUserInput(entry.request.requestId, {});
              return;
            }
            await actions.onInterruptTurn(entry.request.turnId);
          }}
          onRespond={conversationActions.respondUserInput}
        />
      );
    case "mcpServerElicitation":
      return (
        <CodexMcpElicitationRequestCard
          request={entry.request}
          onRespond={conversationActions.respondMcpElicitation}
        />
      );
    case "optionPicker":
      return (
        <CodexOptionPickerRequestCard
          request={entry.request}
          onRespond={conversationActions.respondOptionPicker}
        />
      );
    case "setupCodexStep":
      return (
        <CodexSetupCodexStepRequestCard
          request={entry.request}
          onRespond={conversationActions.respondSetupCodexStep}
        />
      );
    case "implementPlan":
      const request = entry.request;
      return (
        <CodexImplementPlanRequestCard
          request={request}
          onRespond={async (response) => {
            if (response.type === "implement") {
              await intelligenceController?.flush();
              const selection = intelligenceController?.getSelection();
              if (selection && actions.onIntelligenceSelectionChange) {
                await actions.onIntelligenceSelectionChange(selection, {
                  collaborationMode: "default",
                });
              } else {
                await actions.onCollaborationModeChange("default");
              }
              await actions.onSendPrompt(
                `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}\n${request.planContent}`,
                {
                  collaborationMode: "default",
                  ...(selection ? buildComposerIntelligenceTurnOverrides(selection) : {}),
                },
              );
              return;
            }
            if (response.type === "followUp") {
              await actions.onSendPrompt(response.prompt);
              return;
            }
            await actions.onCollaborationModeChange("default");
            await actions.onResolvePlanImplementationRequest(entry.conversationId, request.turnId);
          }}
        />
      );
  }
}
