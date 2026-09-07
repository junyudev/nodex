import { CalendarClock } from "@/components/shared/icons/generic-icons";
import type { ToolComponentProps } from "./get-tool-component";
import type { AutomationUpdateRenderState } from "./dynamic-tool-call-utils";

function openAutomationUpdatePageTarget(
  state: AutomationUpdateRenderState,
  onOpenSummaryScheduledAutomation?: ToolComponentProps["onOpenSummaryScheduledAutomation"],
) {
  if (!onOpenSummaryScheduledAutomation) return;
  if (!state.automationId && !state.createInput && !state.updateInput) return;
  void onOpenSummaryScheduledAutomation?.({
    proposalId: state.proposalId,
    automationId: state.automationId,
    createInput: state.createInput,
    mode:
      state.displayMode === "suggested-create" || state.displayMode === "suggested-update"
        ? state.displayMode
        : "open",
    title: state.title,
    updateInput: state.updateInput,
  });
}

export function AutomationUpdatePage({
  initialState,
  onOpenSummaryScheduledAutomation,
}: {
  initialState: AutomationUpdateRenderState;
  onOpenSummaryScheduledAutomation?: ToolComponentProps["onOpenSummaryScheduledAutomation"];
}) {
  const state = initialState;
  const canOpen = Boolean(
    onOpenSummaryScheduledAutomation &&
    (state.automationId || state.createInput || state.updateInput) &&
    !state.disabledReason,
  );
  const statusLabel = state.statusLabel;
  const subtitle = [statusLabel, state.subtitle].filter(Boolean).join(" · ");

  return (
    <div className="my-1">
      <div className="rounded-md border border-token-border-light bg-token-bg-primary/70">
        <button
          type="button"
          aria-label={[state.title, subtitle].filter(Boolean).join(" · ")}
          className="w-full cursor-interaction text-left hover:bg-token-list-hover-background/30 focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset disabled:cursor-default"
          disabled={!canOpen}
          onClick={() => openAutomationUpdatePageTarget(state, onOpenSummaryScheduledAutomation)}
        >
          <div className="flex min-w-0 items-center gap-2 px-2 py-2">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-token-bg-secondary text-token-text-secondary">
              <CalendarClock className="size-5" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-size-chat text-token-conversation-summary-leading">
                  {state.title}
                </span>
                <span className="shrink-0 text-size-chat text-token-conversation-summary-trailing">
                  {canOpen ? "Open" : state.openLabel}
                </span>
              </span>
              {subtitle ? (
                <span className="truncate text-xs text-token-text-secondary">{subtitle}</span>
              ) : null}
            </span>
          </div>
        </button>
        {state.disabledReason ? (
          <div className="border-t border-token-border-light px-2 py-2">
            <span className="min-w-0 text-xs text-token-editor-error-foreground">
              {state.disabledReason}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
