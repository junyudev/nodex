import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { NodexTooltip } from "./thread-message-actions-deps";
import {
  CheckmarkIcon,
  CopyIcon,
  ResponseCopyIcon,
  EditIcon,
  ForkIcon,
} from "../../../../components/shared/icons";
import { cn } from "../../../../lib/utils";
import { getMessageCopyHtml, writeMessageToClipboard } from "./message-clipboard";
import { footerText } from "./thread-footer-i18n";
import { formatThreadMessageTimestamp } from "./thread-message-timestamp";

const USER_COPY_FEEDBACK_MS = 1500;
const ASSISTANT_COPY_FEEDBACK_MS = 2000;

export const threadMessageActionButtonClassName = `
  border-token-border no-drag cursor-interaction flex items-center
  gap-1 border whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed
  disabled:opacity-40 rounded-full electron:rounded-md text-token-text-tertiary
  enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background
  border-transparent electron:p-1
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
    <NodexTooltip tooltipContent={tooltip} side="top" delay={700} sideOffset={2}>
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
          : "extension:-translate-x-1.5 electron:-translate-x-1 mt-1.5 flex h-5 items-center justify-start gap-0.5",
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
  variant = "assistant",
  hoverOnly = false,
}: {
  sentAtMs: number | null | undefined;
  nowMs?: number;
  variant?: "assistant" | "user";
  hoverOnly?: boolean;
}) {
  const timestampText = formatThreadMessageTimestamp(sentAtMs, nowMs);
  if (timestampText === null) return null;

  return (
    <span
      className={cn(
        "flex h-full shrink-0 items-center opacity-0 group-hover:opacity-100",
        variant === "assistant" && "ms-1.5",
        !hoverOnly && "group-focus-within:opacity-100",
      )}
    >
      <span className="whitespace-nowrap text-xs leading-5 text-token-text-tertiary">
        {timestampText}
      </span>
    </span>
  );
}

export function CopyMessageIcon({ className }: { className?: string }) {
  return <CopyIcon className={cn("shrink-0", className ?? "icon-xs electron:icon-sm")} />;
}

export function CopyMessageActionButton({
  text,
  getText,
  html,
  getHtml,
  label = "Copy message",
  copiedLabel = "Copied",
  tooltipLabel = "Copy message",
  copiedTooltipLabel = "Copied",
  feedbackMs = ASSISTANT_COPY_FEEDBACK_MS,
  iconClassName,
  responseIcon = false,
  stopPropagation = false,
  className,
}: {
  text?: string;
  getText?: () => string;
  html?: string | null;
  getHtml?: () => string | null;
  label?: string;
  copiedLabel?: string;
  tooltipLabel?: string;
  copiedTooltipLabel?: string;
  feedbackMs?: number;
  iconClassName?: string;
  responseIcon?: boolean;
  stopPropagation?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const copyingRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (trigger: HTMLElement) => {
    if (resetTimerRef.current !== null || copyingRef.current) return;
    copyingRef.current = true;
    let didCopy = false;
    try {
      didCopy = await writeMessageToClipboard(
        getText?.() ?? text ?? "",
        getHtml?.() ?? html ?? getMessageCopyHtml(trigger),
      );
    } catch {
      return;
    } finally {
      copyingRef.current = false;
    }
    if (!didCopy || !mountedRef.current) return;

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
      label={footerText(copied ? copiedLabel : label)}
      tooltip={footerText(copied ? copiedTooltipLabel : tooltipLabel)}
      className={cn(copied && "text-token-foreground", className)}
      onClick={(event) => {
        if (stopPropagation) {
          event.stopPropagation();
        }
        if (!copied) void handleCopy(event.currentTarget);
      }}
    >
      {copied ? (
        <CheckmarkIcon className={cn("shrink-0", iconClassName ?? "icon-xs electron:icon-sm")} />
      ) : responseIcon ? (
        <ResponseCopyIcon className={cn("shrink-0", iconClassName ?? "icon-xs electron:icon-sm")} />
      ) : (
        <CopyMessageIcon className={iconClassName} />
      )}
    </ThreadActionIconButton>
  );
}

export function EditMessageIcon({ className }: { className?: string }) {
  return <EditIcon className={cn("shrink-0", className ?? "icon-xs electron:icon-sm")} />;
}
export type AssistantMessageRating = "thumbs_up" | "thumbs_down";

export function ForkMessageIcon({ className }: { className?: string }) {
  return <ForkIcon className={cn("shrink-0", className ?? "icon-xs electron:icon-sm")} />;
}

export { ASSISTANT_COPY_FEEDBACK_MS, USER_COPY_FEEDBACK_MS };
