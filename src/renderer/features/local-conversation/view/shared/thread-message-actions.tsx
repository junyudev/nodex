import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
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

export function ThumbRatingIcon({ className }: { className?: string }) {
  return (
    <svg
      width={20}
      height={21}
      viewBox="0 0 20 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("icon-xs", className)}
      aria-hidden="true"
    >
      <path
        d="M10.9153 2.11274L11.2942 2.16059L11.4749 2.18794C13.2633 2.51488 14.4107 4.29005 13.9749 6.05513L13.9261 6.23188L13.3987 7.94477C13.7708 7.94862 14.0961 7.95676 14.3792 7.97895C14.8737 8.01773 15.3109 8.10046 15.7015 8.3061L15.8528 8.39106C16.5966 8.8364 17.1278 9.56913 17.3167 10.4204L17.347 10.5825C17.403 10.9628 17.3647 11.3561 17.2835 11.7827C17.2375 12.0246 17.1735 12.2941 17.096 12.5961L16.8255 13.6049L16.4456 15.0004C16.2076 15.873 16.0438 16.5085 15.7366 17.0034L15.595 17.2075C15.2989 17.5908 14.9197 17.9009 14.4866 18.1137L14.2982 18.1987C13.6885 18.4502 12.9785 18.4379 11.9446 18.4379H7.33331C6.64422 18.4379 6.08726 18.4386 5.63702 18.4018C5.23638 18.3691 4.87565 18.3039 4.53936 18.1596L4.39679 18.0932C3.87576 17.8277 3.43916 17.4239 3.13507 16.9282L3.013 16.7094C2.82119 16.3328 2.74182 15.927 2.7044 15.4692C2.66762 15.019 2.66827 14.462 2.66827 13.7729V11.9399C2.66827 11.2077 2.66214 10.7104 2.77569 10.2866L2.83722 10.0854C3.17599 9.09055 3.99001 8.32371 5.01397 8.04927L5.17706 8.01216C5.56592 7.93723 6.02595 7.94087 6.66632 7.94087C6.9429 7.94087 7.19894 7.79325 7.33624 7.55317L10.2562 2.44282L10.3118 2.36079C10.4544 2.18027 10.6824 2.08379 10.9153 2.11274ZM7.33136 14.4399C7.33136 15.257 7.33714 15.5356 7.39386 15.7475L7.42999 15.8647C7.62644 16.4415 8.09802 16.8863 8.69171 17.0454L8.87042 17.0795C9.07652 17.1051 9.38687 17.1079 10.0003 17.1079H11.9446C13.099 17.1079 13.4838 17.0956 13.7903 16.9692L13.8997 16.9194C14.1508 16.796 14.3716 16.6172 14.5433 16.395L14.6155 16.2895C14.7769 16.0281 14.8968 15.6246 15.1624 14.6508L15.5433 13.2553L15.8079 12.2651C15.8804 11.9831 15.9368 11.744 15.9769 11.5336C16.0364 11.2209 16.0517 11.0104 16.0394 10.852L16.0179 10.7084C15.9156 10.2478 15.641 9.84669 15.2542 9.5854L15.0814 9.48286C14.9253 9.40072 14.6982 9.33832 14.2747 9.30513C13.8477 9.27168 13.2923 9.27095 12.5003 9.27095C12.2893 9.27095 12.0905 9.17109 11.9651 9.00141C11.8398 8.83166 11.8025 8.6123 11.8646 8.41059L12.6556 5.84028L12.7054 5.63618C12.8941 4.6324 12.216 3.65244 11.1878 3.49067L8.49054 8.21235C8.23033 8.66771 7.81431 9.00136 7.33136 9.16255V14.4399ZM3.99835 13.7729C3.99835 14.4839 3.99924 14.9773 4.03058 15.3608C4.06128 15.7365 4.11804 15.9479 4.19854 16.1059L4.26886 16.2319C4.44517 16.5195 4.69805 16.7537 5.0003 16.9077L5.13019 16.9633C5.27397 17.0148 5.46337 17.0526 5.74542 17.0756C5.97772 17.0946 6.25037 17.1009 6.58722 17.104C6.41249 16.8579 6.27075 16.5864 6.1712 16.2944L6.10968 16.0922C5.99614 15.6685 6.00128 15.1719 6.00128 14.4399V9.27583C5.79386 9.27957 5.65011 9.28627 5.53741 9.30024L5.3587 9.33345C4.76502 9.49252 4.29247 9.93735 4.09601 10.5141L4.06085 10.6313C4.00404 10.8433 3.99835 11.1221 3.99835 11.9399V13.7729Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function AssistantRatingButton({
  rating,
  selectedRating,
  onSelect,
}: {
  rating: AssistantMessageRating;
  selectedRating: AssistantMessageRating | null;
  onSelect: (rating: AssistantMessageRating) => void;
}) {
  const selected = selectedRating === rating;
  const label = rating === "thumbs_up" ? "Good response" : "Bad response";

  return (
    <NodexTooltip tooltipContent={label} side="top" delay={0}>
      <ThreadActionIconButton
        label={label}
        active={selected}
        aria-pressed={selected}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          if (selected) return;
          onSelect(rating);
        }}
      >
        <ThumbRatingIcon className={rating === "thumbs_down" ? "rotate-180" : undefined} />
      </ThreadActionIconButton>
    </NodexTooltip>
  );
}

export function ForkMessageIcon({ className }: { className?: string }) {
  return <ForkIcon className={cn("icon-xs", className)} />;
}

export { ASSISTANT_COPY_FEEDBACK_MS, USER_COPY_FEEDBACK_MS };
