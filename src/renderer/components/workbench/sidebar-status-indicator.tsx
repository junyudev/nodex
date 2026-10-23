import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { SESSION_LIVE_INDICATOR_LABELS } from "@/lib/session-execution";
import type { SidebarRowStatus } from "@/lib/sidebar-status";

const SLOT_CLASS = "relative flex size-5 shrink-0 items-center justify-center";

/** The unread dot or spinner that fills a sidebar row's 20px trailing status slot. */
export function SidebarStatusIndicator({
  status,
  label,
}: {
  status: SidebarRowStatus;
  /** Names the dot when nothing else describes it, such as on a collapsed group. */
  label?: string;
}) {
  switch (status) {
    case "running":
      return (
        <span
          role="status"
          aria-label={SESSION_LIVE_INDICATOR_LABELS.running}
          className={`${SLOT_CLASS} text-token-foreground/70`}
          data-sidebar-status="running"
        >
          <ActivitySpinnerIcon className="icon-xs shrink-0" animationDurationMs={2_000} />
        </span>
      );
    case "background":
      return (
        <span
          role="img"
          aria-label={SESSION_LIVE_INDICATOR_LABELS.background}
          className={`${SLOT_CLASS} text-token-description-foreground/70`}
          data-sidebar-status="background"
        >
          <ActivitySpinnerIcon className="icon-xs shrink-0" animationDurationMs={5_000} />
        </span>
      );
    case "attention":
    case "unread":
      return (
        <span
          {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
          className={SLOT_CLASS}
          data-sidebar-status={status}
        >
          <span className="icon-xs relative scale-50">
            <span className="absolute inset-0 rounded-full bg-info-solid" />
          </span>
        </span>
      );
  }
}
