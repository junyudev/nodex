import type { CodexAutomationUpdateView } from "../../../../../shared/types";
import { formatCodexScheduledAutomationRruleSummary } from "../../../../lib/codex-scheduled-automation-display";
import type { AutomationUpdateRenderState } from "./dynamic-tool-call-utils";

export function resolveNativeAutomationUpdateRenderState(
  view: CodexAutomationUpdateView,
): AutomationUpdateRenderState | null {
  if (view.source !== "nativeMcp") return null;
  const { proposal, result } = view;
  const displayMode = proposal
    ? proposal.mode === "suggested_create"
      ? "suggested-create"
      : "suggested-update"
    : (result?.mode ?? "view");
  const statusLabels = {
    "suggested-create": "Proposed scheduled task",
    "suggested-update": "Proposed update",
    create: "Scheduled task created",
    update: "Scheduled task updated",
    delete: "Scheduled task deleted",
    view: "Scheduled task",
  };
  return {
    proposalId: proposal ? view.callId : undefined,
    automationId:
      proposal?.mode === "suggested_update" ? proposal.id : (result?.automationId ?? null),
    canAccept: proposal !== undefined,
    createInput: proposal?.mode === "suggested_create" ? proposal : null,
    updateInput: proposal?.mode === "suggested_update" ? proposal : null,
    disabledReason: displayMode === "delete" ? "This scheduled task has been deleted." : null,
    displayMode,
    openLabel: displayMode === "delete" ? "Deleted" : "Open",
    result: result
      ? { ...result, deleteStatus: result.deleteStatus ?? null, snapshot: result.snapshot ?? null }
      : null,
    statusLabel: statusLabels[displayMode],
    subtitle:
      formatCodexScheduledAutomationRruleSummary(
        proposal?.rrule ?? result?.snapshot?.rrule ?? null,
      ) ?? "Custom schedule",
    title: proposal?.name ?? result?.snapshot?.name ?? "Scheduled task",
  };
}
