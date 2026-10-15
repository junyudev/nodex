import type { ThreadStageActions } from "../../../thread-stage-types";

type UserInputAnswers = Parameters<ThreadStageActions["onRespondUserInput"]>[1];
type UserInputRequestId = Parameters<ThreadStageActions["onRespondUserInput"]>[0];
type McpElicitationAction = Parameters<ThreadStageActions["onRespondMcpElicitation"]>[1];
type McpElicitationRequestId = Parameters<ThreadStageActions["onRespondMcpElicitation"]>[0];
type OptionPickerResponse = Parameters<NonNullable<ThreadStageActions["onRespondOptionPicker"]>>[1];
type OptionPickerRequestId = Parameters<
  NonNullable<ThreadStageActions["onRespondOptionPicker"]>
>[0];
type SetupCodexStepResponse = Parameters<
  NonNullable<ThreadStageActions["onRespondSetupCodexStep"]>
>[1];
type SetupCodexStepRequestId = Parameters<
  NonNullable<ThreadStageActions["onRespondSetupCodexStep"]>
>[0];

interface BindPendingRequestConversationActionsInput {
  actions: ThreadStageActions;
  conversationId: string;
}

/** Owns the conversation-scoped transport context shared by direct request cards. */
export function bindPendingRequestConversationActions({
  actions,
  conversationId,
}: BindPendingRequestConversationActionsInput) {
  const context = { conversationId };

  return {
    respondUserInput: async (requestId: UserInputRequestId, answers: UserInputAnswers) => {
      await actions.onRespondUserInput(requestId, answers, context);
    },
    respondMcpElicitation: async (
      requestId: McpElicitationRequestId,
      action: McpElicitationAction,
    ) => {
      await actions.onRespondMcpElicitation(requestId, action, context);
    },
    respondOptionPicker: async (
      requestId: OptionPickerRequestId,
      response: OptionPickerResponse,
    ) => {
      await actions.onRespondOptionPicker?.(requestId, response, context);
    },
    respondSetupCodexStep: async (
      requestId: SetupCodexStepRequestId,
      response: SetupCodexStepResponse,
    ) => {
      await actions.onRespondSetupCodexStep?.(requestId, response, context);
    },
  };
}
