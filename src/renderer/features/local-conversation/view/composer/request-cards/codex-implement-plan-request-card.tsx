import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import type { CodexPlanImplementationRequest } from "../../../../../lib/types";
import {
  REQUEST_INPUT_COMPOSER_POLICY,
  RequestComposerView,
  buildUserInputAnswers,
  type RequestComposerRequest,
} from "../../shared/request-cards/local-conversation-request-cards";
import { buildCodexCanonicalRequestIdentityKey } from "../../../../../../shared/codex-conversation-state/codex-conversation-state";

interface CodexImplementPlanRequestCardProps {
  request: CodexPlanImplementationRequest;
  onRespond: (
    response: { type: "dismiss" } | { type: "implement" } | { type: "followUp"; prompt: string },
  ) => Promise<void>;
}

function buildPlanComposerRequest(
  request: CodexPlanImplementationRequest,
  intl: IntlShape,
): RequestComposerRequest {
  const questionId = buildCodexCanonicalRequestIdentityKey(request.requestId);
  const question = intl.formatMessage({
    id: "conversation.codexImplementPlanRequestCard.question",
    defaultMessage: "Implement this plan?",
  });
  return {
    requestId: request.requestId,
    questions: [
      {
        id: questionId,
        header: question,
        question,
        isOther: true,
        isSecret: false,
        otherPlaceholder: intl.formatMessage({
          id: "conversation.codexImplementPlanRequestCard.otherPlaceholder",
          defaultMessage: "No, and tell Nodex what to do differently",
        }),
        options: [
          {
            label: intl.formatMessage({
              id: "conversation.codexImplementPlanRequestCard.implement",
              defaultMessage: "Yes, implement this plan",
            }),
            description: "",
          },
        ],
      },
    ],
  };
}

export function CodexImplementPlanRequestCard({
  request,
  onRespond,
}: CodexImplementPlanRequestCardProps) {
  const intl = useIntl();
  const composerRequest = buildPlanComposerRequest(request, intl);
  const dismiss = async () => {
    try {
      await onRespond({ type: "dismiss" });
    } catch {
      throw new Error(
        getIntl().formatMessage({
          id: "conversation.codexImplementPlanRequestCard.dismissFailed",
          defaultMessage: "Could not dismiss plan — try again",
        }),
      );
    }
  };

  return (
    <RequestComposerView
      request={composerRequest}
      policy={REQUEST_INPUT_COMPOSER_POLICY}
      isPlanMode
      onSubmit={async (nextRequest, state) => {
        const questionId = nextRequest.questions[0]?.id;
        const answer = questionId
          ? (buildUserInputAnswers(nextRequest, state)[questionId]?.[0]?.trim() ?? "")
          : "";
        if (!answer) {
          await dismiss();
          return;
        }
        if (answer === nextRequest.questions[0]?.options?.[0]?.label) {
          await onRespond({ type: "implement" });
          return;
        }
        await onRespond({ type: "followUp", prompt: answer });
      }}
      onEscapeDismiss={async () => {
        await dismiss();
      }}
      submitErrorMessage={intl.formatMessage({
        id: "conversation.codexImplementPlanRequestCard.submitFailed",
        defaultMessage: "Could not submit plan implementation request",
      })}
      dismissErrorMessage={intl.formatMessage({
        id: "conversation.codexImplementPlanRequestCard.dismissFailed",
        defaultMessage: "Could not dismiss plan — try again",
      })}
    />
  );
}
