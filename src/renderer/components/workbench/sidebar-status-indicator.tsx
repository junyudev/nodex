import { useIntl } from "@/lib/i18n";
import { ChatWaitingIcon } from "@/components/shared/chat-waiting-icon";
import { ActivitySpinnerIcon, ClockIcon, EditIcon } from "@/components/shared/icons";
import { sessionLiveIndicatorLabel } from "@/lib/session-execution";
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
  const intl = useIntl();
  switch (status) {
    case "running":
      return (
        <span
          role="status"
          aria-label={sessionLiveIndicatorLabel("running", intl)}
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
          aria-label={sessionLiveIndicatorLabel("background", intl)}
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
    case "woke":
      return (
        <span
          role="img"
          aria-label={
            label ??
            intl.formatMessage({
              id: "workbench.sidebarStatusIndicator.woke",
              defaultMessage: "Back from snooze",
            })
          }
          className={`${SLOT_CLASS} text-token-charts-blue`}
          data-sidebar-status="woke"
        >
          <ClockIcon className="icon-2xs" />
        </span>
      );
    case "draft":
      return (
        <span aria-hidden="true" className={RESTING_SLOT_CLASS} data-sidebar-status="draft">
          {/* The pencil's wider viewBox draws it smaller; 16px matches the clock's weight. */}
          <EditIcon className="icon-xs" />
        </span>
      );
    case "snoozed":
      return (
        <span aria-hidden="true" className={RESTING_SLOT_CLASS} data-sidebar-status="snoozed">
          <ClockIcon className="icon-2xs" />
        </span>
      );
  }
}
