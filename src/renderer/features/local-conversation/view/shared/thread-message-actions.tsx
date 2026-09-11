import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { NodexTooltip } from "./thread-message-actions-deps";
import { CheckmarkIcon, CopyIcon, EditIcon, ForkIcon } from "../../../../components/shared/icons";
import { cn } from "../../../../lib/utils";
import { writeTextToClipboard } from "../../../../lib/clipboard";
import { formatThreadMessageTimestamp } from "./thread-message-timestamp";

const USER_COPY_FEEDBACK_MS = 1500;
const ASSISTANT_COPY_FEEDBACK_MS = 2000;
const electronMessageActionSvgSizeClassName = "electron:[&>svg]:icon-sm";

export const threadMessageActionButtonClassName = `
  border-token-border no-drag cursor-interaction flex items-center
  gap-1 border whitespace-nowrap focus:outline-none disabled:cursor-not-allowed
  disabled:opacity-40 rounded-full electron:rounded-md text-token-text-tertiary
  enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background
  border-transparent electron:p-1 ${electronMessageActionSvgSizeClassName}
  flex items-center justify-center p-0.5 select-none
`;

const threadMessageActionButtonActiveClassName = `
  text-token-foreground enabled:hover:bg-token-list-hover-background
  data-[state=open]:bg-token-list-hover-background border-transparent
`;

interface ThreadActionIconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> {
  label: string;
  children: ReactNode;
  active?: boolean;
  state?: "open" | "closed";
  tooltip?: ReactNode;
}

export function ThreadActionIconButton({
  label,
  children,
  active = false,
  className,
  state = "closed",
  tooltip,
  ...props
}: ThreadActionIconButtonProps) {
  const button = (
    <button
      type="button"
      className={cn(
        threadMessageActionButtonClassName,
        active && threadMessageActionButtonActiveClassName,
        className,
      )}
      aria-label={label}
      data-state={state}
      {...props}
    >
      {children}
    </button>
  );

  if (!tooltip) return button;

  return (
    <NodexTooltip tooltipContent={tooltip} side="top" delay={0}>
      {button}
    </NodexTooltip>
  );
}

export function ThreadMessageActionRow({
  align,
  className,
  children,
}: {
  align: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        align === "end"
          ? "mr-1 ms-1 flex items-center gap-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          : "extension:-translate-x-1.5 electron:-translate-x-2 mt-1.5 flex h-5 items-center justify-start gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MessageTimestamp({
  sentAtMs,
  nowMs,
}: {
  sentAtMs: number | null | undefined;
  nowMs?: number;
}) {
  const timestampText = formatThreadMessageTimestamp(sentAtMs, nowMs);
  if (timestampText === null) return null;

  return (
    <span className="ml-1.5 flex h-full shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
      <span className="whitespace-nowrap text-xs leading-5 text-token-text-tertiary">
        {timestampText}
      </span>
    </span>
  );
}

export function CopyMessageIcon({ className }: { className?: string }) {
  return <CopyIcon className={cn("icon-xs", className)} />;
}

export function CopyMessageActionButton({
  text,
  getText,
  label = "Copy message",
  copiedLabel = "Copied",
  tooltipLabel = "Copy",
  copiedTooltipLabel = "Copied",
  feedbackMs = ASSISTANT_COPY_FEEDBACK_MS,
  disabledWhenCopied = false,
  stopPropagation = false,
  className,
}: {
  text?: string;
  getText?: () => string;
  label?: string;
  copiedLabel?: string;
  tooltipLabel?: string;
  copiedTooltipLabel?: string;
  feedbackMs?: number;
  disabledWhenCopied?: boolean;
  stopPropagation?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    const didCopy = await writeTextToClipboard(getText?.() ?? text ?? "");
    if (!didCopy) return;

    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }

    setCopied(true);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, feedbackMs);
  };

  return (
    <ThreadActionIconButton
      label={copied ? copiedLabel : label}
      tooltip={copied ? copiedTooltipLabel : tooltipLabel}
      className={cn(copied && "bg-token-foreground/10 text-token-foreground", className)}
      disabled={disabledWhenCopied && copied}
      state={copied ? "open" : "closed"}
      onClick={(event) => {
        if (stopPropagation) {
          event.stopPropagation();
        }
        void handleCopy();
      }}
    >
      {copied ? <CheckmarkIcon className="icon-xs" /> : <CopyMessageIcon />}
    </ThreadActionIconButton>
  );
}

export function EditMessageIcon({ className }: { className?: string }) {
  return <EditIcon className={cn("icon-xs", className)} />;
}
export type AssistantMessageRating = "thumbs_up" | "thumbs_down";

export function ForkMessageIcon({ className }: { className?: string }) {
  return <ForkIcon className={cn("icon-xs", className)} />;
}

export { ASSISTANT_COPY_FEEDBACK_MS, USER_COPY_FEEDBACK_MS };
