import { useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle } from "@/components/shared/icons/generic-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { toastFailure } from "@/lib/failure-toast";
import { cn } from "@/lib/utils";
import type { ComposerNotice, ComposerNoticeAction } from "../../thread-stage-types";
import { COMPOSER_ATTACHED_TAB_CLASS, ComposerAttachedTabSlot } from "../composer-context-rail";

/**
 * A standing condition that keeps the composer from sending, on one line beside the composer
 * instead of inside its text field. A docked composer wears it as a tab tucked under its top
 * edge, the way the context rail is attached; a floating composer, whose frame is the surface,
 * keeps it as an inset row above the field. The Agent's own explanation follows the title in a
 * quieter tone, and the whole of it is a hover away when the line is too narrow for it.
 */
export function ComposerNoticeRail({
  notice,
  placement,
}: {
  notice: ComposerNotice;
  placement: "attached" | "inset";
}) {
  const Icon = notice.tone === "danger" ? AlertCircle : AlertTriangle;
  const detail = notice.detail?.trim() || null;
  const row = (
    <div
      role="status"
      aria-live="polite"
      data-composer-notice={notice.tone}
      className={cn(
        "relative flex min-w-0 animate-in items-center gap-2 text-size-chat-sm leading-5 duration-150 select-none fade-in-0 slide-in-from-bottom-1",
        notice.tone === "danger"
          ? "bg-[color-mix(in_srgb,var(--color-background-danger-surface)_32%,var(--color-background-composer-action-bar))]"
          : "bg-[color-mix(in_srgb,var(--color-background-warning-surface)_32%,var(--color-background-composer-action-bar))]",
        placement === "attached"
          ? cn(COMPOSER_ATTACHED_TAB_CLASS, "pr-1 pl-3")
          : // Concentric with the floating card: its 22px corner less this 8px inset.
            "mx-2 mt-2 rounded-[14px] py-1 pr-1 pl-2.5",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "icon-xs shrink-0",
          notice.tone === "danger" ? "text-danger" : "text-[var(--color-text-warning)]",
        )}
      />
      <NodexTooltip
        disabled={!detail}
        tooltipContent={
          <span className="block max-w-80 whitespace-pre-wrap">
            {renderNoticeText(detail ?? "")}
          </span>
        }
      >
        <p className="min-w-0 flex-1 truncate">
          <span className="text-token-foreground">{notice.title}</span>
          {detail ? (
            <span className="ml-2 text-token-description-foreground">
              {renderNoticeText(detail)}
            </span>
          ) : null}
        </p>
      </NodexTooltip>
      {notice.actions?.length ? (
        <ComposerNoticeActions key={notice.key} notice={notice} actions={notice.actions} />
      ) : null}
    </div>
  );
  return placement === "attached" ? <ComposerAttachedTabSlot>{row}</ComposerAttachedTabSlot> : row;
}

function ComposerNoticeActions({
  notice,
  actions,
}: {
  notice: ComposerNotice;
  actions: readonly ComposerNoticeAction[];
}) {
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const run = async (action: ComposerNoticeAction) => {
    setPendingLabel(action.label);
    try {
      await action.run();
    } catch (cause) {
      // The condition still stands, so the toast restates it with the reason the fix failed.
      toastFailure(notice.title, cause);
    } finally {
      setPendingLabel(null);
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {actions.map((action, index) => (
        <button
          key={action.label}
          type="button"
          disabled={pendingLabel !== null}
          aria-busy={pendingLabel === action.label || undefined}
          className={cn(
            "h-6 shrink-0 cursor-interaction rounded-full px-2 whitespace-nowrap text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-token-focus-border disabled:cursor-default disabled:opacity-60",
            index === 0
              ? "bg-token-foreground/[0.07] enabled:hover:bg-token-foreground/[0.12]"
              : "text-token-text-secondary enabled:hover:bg-token-foreground/[0.07] enabled:hover:text-token-foreground",
          )}
          onClick={() => void run(action)}
        >
          {pendingLabel === action.label ? (action.pendingLabel ?? action.label) : action.label}
        </button>
      ))}
    </div>
  );
}

/** Agent messages quote commands in backticks; they read as code. */
function renderNoticeText(text: string): ReactNode {
  const parts = text.split("`");
  if (parts.length < 3) return text;
  return parts.map((part, index) =>
    index % 2 === 1 && index < parts.length - 1 ? (
      <code key={index} className="font-mono text-[0.92em]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}
