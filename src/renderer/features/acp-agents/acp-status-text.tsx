import { cn } from "@/lib/utils";
import type { AcpInstanceStatus, AcpStatusTone } from "./acp-agent-model";

const TONE_CLASS: Record<AcpStatusTone, string> = {
  default: "text-token-text-secondary",
  info: "text-info",
  danger: "text-danger",
  muted: "text-token-description-foreground",
};

export function AcpStatusText({
  status,
  pending = false,
  className,
}: {
  readonly status: AcpInstanceStatus;
  /** Saved changes wait for the Agent's current work to finish. */
  readonly pending?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn("min-w-0 truncate text-xs tabular-nums", TONE_CLASS[status.tone], className)}
    >
      {status.label}
      {status.detail && status.tone !== "danger" ? (
        <span className="text-token-description-foreground"> · {status.detail}</span>
      ) : null}
      {pending ? (
        <span className="text-token-description-foreground"> · Changes pending</span>
      ) : null}
    </span>
  );
}
