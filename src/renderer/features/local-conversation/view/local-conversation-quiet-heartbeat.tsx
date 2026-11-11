import { ChevronRightIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type { QuietHeartbeat, QuietHeartbeatGroup } from "../projection/quiet-heartbeat";
import { formatThreadMessageTimestamp } from "./shared/thread-message-timestamp";

/**
 * A receipt for beats that finished without asking for attention. It reads as one muted line:
 * what it is, what the Agent found, and when; the Turn itself stays one click away.
 */
function QuietReceipt({
  label,
  beat,
  expanded,
  nested = false,
  hook,
  onToggle,
}: {
  label: string;
  /** Omitted once the rows beneath already say it. */
  beat: QuietHeartbeat | null;
  expanded: boolean;
  nested?: boolean;
  hook: "beat" | "group";
  onToggle: () => void;
}) {
  const timestamp = beat ? formatThreadMessageTimestamp(beat.atMs) : null;
  const message = beat?.message || null;
  return (
    <button
      type="button"
      className={cn(
        "group/quiet flex w-full min-w-0 cursor-interaction items-baseline gap-1.5 rounded-md py-1 text-left text-size-chat text-token-text-tertiary",
        "hover:text-token-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2",
        nested && "ps-4",
      )}
      aria-expanded={expanded}
      data-heartbeat-quiet-beat={hook === "beat" ? "" : undefined}
      data-heartbeat-quiet-group={hook === "group" ? "" : undefined}
      onClick={onToggle}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "icon-2xs shrink-0 self-center transition-transform duration-150",
          expanded && "rotate-90",
        )}
      />
      {/* Beneath its group's row the count already names these; only the finding is new. */}
      {nested && message ? null : (
        <span className="shrink-0 text-token-text-secondary">{label}</span>
      )}
      {message ? <span className="min-w-0 truncate">{message}</span> : null}
      {timestamp && beat?.atMs != null ? (
        <time
          className="ms-auto shrink-0 ps-2 text-xs tabular-nums"
          dateTime={new Date(beat.atMs).toISOString()}
        >
          {timestamp}
        </time>
      ) : null}
    </button>
  );
}

export function LocalConversationQuietHeartbeat({
  beat,
  expanded,
  nested,
  onToggle,
}: {
  beat: QuietHeartbeat;
  expanded: boolean;
  /** Listed beneath the row that groups it. */
  nested?: boolean;
  onToggle: () => void;
}) {
  return (
    <QuietReceipt
      label="Quiet check"
      beat={beat}
      expanded={expanded}
      nested={nested}
      hook="beat"
      onToggle={onToggle}
    />
  );
}

export function LocalConversationQuietHeartbeatGroup({
  group,
  expanded,
  onToggle,
}: {
  group: QuietHeartbeatGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <QuietReceipt
      label={`${group.count} quiet checks`}
      beat={expanded ? null : group.latest}
      expanded={expanded}
      hook="group"
      onToggle={onToggle}
    />
  );
}
