import { ChatWaitingIcon } from "@/components/shared/chat-waiting-icon";
import { ActivitySpinnerIcon, ClockIcon, EditIcon } from "@/components/shared/icons";
import { SESSION_LIVE_INDICATOR_LABELS } from "@/lib/session-execution";
import type { SidebarRowStatus } from "@/lib/sidebar-status";

const SLOT_CLASS = "relative flex size-5 shrink-0 items-center justify-center";
/** Resting glyphs are what the person left behind, so they stay quieter than any live status. */
const RESTING_SLOT_CLASS = `${SLOT_CLASS} text-token-description-foreground`;

/** The glyph that fills a sidebar row's 20px trailing status slot. */
export function SidebarStatusIndicator({
  status,
  label,
}: {
  status: SidebarRowStatus;
  /** Names the glyph when nothing else describes it, such as on a collapsed group. */
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
      return (
        <span
          {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
          className={SLOT_CLASS}
          data-sidebar-status="attention"
        >
          <ChatWaitingIcon />
        </span>
      );
    case "unread":
      return (
        <span
          {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
          className={SLOT_CLASS}
          data-sidebar-status="unread"
        >
          <span className="icon-xs relative scale-50">
            <span className="absolute inset-0 rounded-full bg-info-solid" />
          </span>
        </span>
      );
    case "draft":
      return (
        <span aria-hidden="true" className={RESTING_SLOT_CLASS} data-sidebar-status="draft">
          {/* The pencil's wider viewBox draws it smaller; 16px matches the clock's weight. */}
          <EditIcon className="icon-xs" />
        </span>
      );
    case "reminder":
      return (
        <span aria-hidden="true" className={RESTING_SLOT_CLASS} data-sidebar-status="reminder">
          <ClockIcon className="icon-2xs" />
        </span>
      );
  }
}
