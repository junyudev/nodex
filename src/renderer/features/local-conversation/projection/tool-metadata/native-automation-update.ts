import { defineMessages, getIntl } from "@/lib/i18n";
import type { CodexConversationItem, AutomationUpdateView } from "../../../../../shared/types";
import { formatAutomationRruleSummary } from "../../../../lib/automation-display";
import type { AutomationUpdateRenderState } from "./dynamic-tool-call-utils";

/** Native identity exposes an Automation card before its bounded detail read has supplied the action. */
export const isNativeAutomationUpdate = (
  item: Pick<CodexConversationItem, "mcpToolCall" | "automationUpdate">,
): boolean =>
  item.automationUpdate?.source === "nativeMcp" ||
  (item.mcpToolCall?.invocation.server === "nodex_app" &&
    item.mcpToolCall.invocation.tool === "automations_update");

export function resolveNativeAutomationUpdateRenderState(
  view: AutomationUpdateView,
): AutomationUpdateRenderState | null {
  if (view.source !== "nativeMcp") return null;
  const { proposal, result } = view;
  const displayMode = proposal
    ? proposal.operation === "suggested_create"
      ? "suggested-create"
      : "suggested-update"
    : (result?.operation ?? "view");
  const statusLabels = defineMessages({
    "suggested-create": {
      id: "conversation.nativeAutomationUpdate.proposedAutomation",
      defaultMessage: "Proposed automation",
    },
    "suggested-update": {
      id: "conversation.nativeAutomationUpdate.proposedUpdate",
      defaultMessage: "Proposed update",
    },
    create: {
      id: "conversation.nativeAutomationUpdate.created",
      defaultMessage: "Automation created",
    },
    update: {
      id: "conversation.nativeAutomationUpdate.updated",
      defaultMessage: "Automation updated",
    },
    delete: {
      id: "conversation.nativeAutomationUpdate.deleted",
      defaultMessage: "Automation deleted",
    },
    view: { id: "conversation.nativeAutomationUpdate.automation", defaultMessage: "Automation" },
  });
  return {
    proposalId: proposal ? view.callId : undefined,
    automationId:
      proposal?.operation === "suggested_update" ? proposal.id : (result?.automationId ?? null),
    canAccept: proposal !== undefined,
    createInput: proposal?.operation === "suggested_create" ? proposal : null,
    updateInput: proposal?.operation === "suggested_update" ? proposal : null,
    disabledReason:
      displayMode === "delete"
        ? getIntl().formatMessage({
            id: "conversation.nativeAutomationUpdate.automationDeleted",
            defaultMessage: "This automation has been deleted.",
          })
        : null,
    displayMode,
    openLabel:
      displayMode === "delete"
        ? getIntl().formatMessage({
            id: "conversation.nativeAutomationUpdate.deletedLabel",
            defaultMessage: "Deleted",
          })
        : getIntl().formatMessage({
            id: "conversation.nativeAutomationUpdate.open",
            defaultMessage: "Open",
          }),
    result: result
      ? { ...result, deleteStatus: result.deleteStatus ?? null, snapshot: result.snapshot ?? null }
      : null,
    statusLabel: getIntl().formatMessage(statusLabels[displayMode]),
    subtitle:
      formatAutomationRruleSummary(proposal?.rrule ?? result?.snapshot?.rrule ?? null) ??
      getIntl().formatMessage({
        id: "conversation.nativeAutomationUpdate.customSchedule",
        defaultMessage: "Custom schedule",
      }),
    title:
      proposal?.name ??
      result?.snapshot?.name ??
      getIntl().formatMessage({
        id: "conversation.nativeAutomationUpdate.automation",
        defaultMessage: "Automation",
      }),
  };
}
