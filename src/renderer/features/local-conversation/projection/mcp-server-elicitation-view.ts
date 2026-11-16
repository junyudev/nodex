import { getIntl, type IntlShape } from "@/lib/i18n";
import type { CodexMcpServerElicitationAction } from "../../../lib/types";

export interface CompletedMcpServerElicitationView {
  answer: string;
  question: string;
  requestId: string;
  summary: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function resolveQuestion(elicitation: Record<string, unknown>): string | null {
  if (elicitation.kind === "unsupportedOpenAIForm") return null;
  if (elicitation.kind === "toolSuggestion") {
    return nonEmptyString(asRecord(elicitation.suggestion)?.suggest_reason);
  }
  return nonEmptyString(elicitation.message);
}

function resolveAnswer(
  action: CodexMcpServerElicitationAction | null,
  intl: IntlShape,
): CompletedMcpServerElicitationView["answer"] {
  if (action === "accept")
    return intl.formatMessage({
      id: "conversation.mcpServerElicitationView.accepted",
      defaultMessage: "Accepted",
    });
  if (action === "cancel")
    return intl.formatMessage({
      id: "conversation.mcpServerElicitationView.cancelled",
      defaultMessage: "Cancelled",
    });
  if (action === "decline")
    return intl.formatMessage({
      id: "conversation.mcpServerElicitationView.declined",
      defaultMessage: "Declined",
    });
  return intl.formatMessage({
    id: "conversation.mcpServerElicitationView.completed",
    defaultMessage: "Completed",
  });
}

export function resolveCompletedMcpServerElicitationView(
  rawItem: unknown,
  intl: IntlShape = getIntl(),
): CompletedMcpServerElicitationView | null {
  const item = asRecord(rawItem);
  if (item?.completed !== true) return null;

  const elicitation = asRecord(item.elicitation);
  if (!elicitation) return null;
  const question = resolveQuestion(elicitation);
  if (!question) return null;

  const requestId = nonEmptyString(item.requestId);
  if (!requestId) return null;
  const action =
    item.action === "accept" || item.action === "cancel" || item.action === "decline"
      ? item.action
      : null;

  return {
    answer: resolveAnswer(action, intl),
    question,
    requestId,
    summary:
      elicitation.kind === "mcpToolCall"
        ? intl.formatMessage({
            id: "conversation.mcpServerElicitationView.requestedPermission",
            defaultMessage: "Requested permission",
          })
        : intl.formatMessage({
            id: "conversation.mcpServerElicitationView.completedRequest",
            defaultMessage: "Completed request",
          }),
  };
}
