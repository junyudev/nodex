import { useEffect, useMemo, useRef, useState } from "react";
import { SendHorizontal } from "@/components/shared/icons/generic-icons";
import { ActivitySpinnerIcon, PlayIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { formatElapsedSince } from "@/lib/elapsed-time";
import { cn } from "@/lib/utils";
import type { ThreadSectionLinkedThreadState } from "./thread-section-runtime";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatRelativeTime(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "";
  return formatElapsedSince(updatedAt, now);
}

function resolveThreadStateLabel(thread: ThreadSectionLinkedThreadState | null): string {
  if (!thread) return "Not sent";
  if (thread.archived) return "Archived";
  if (thread.statusType === "systemError") return "Error";
  if (thread.statusActiveFlags.includes("waitingOnApproval")) return "Approval";
  if (thread.statusActiveFlags.includes("waitingOnUserInput")) return "Waiting";
  if (thread.statusType === "active") return "Running";
  if (thread.statusType === "idle") return "Ready";
  return "Bound";
}

function resolveLineTone(thread: ThreadSectionLinkedThreadState | null): string {
  if (!thread) return "bg-(--border)";
  if (thread.statusType === "systemError") return "bg-(--red-text)";
  if (thread.statusActiveFlags.length > 0) return "bg-(--orange-text)";
  if (thread.statusType === "active") return "bg-(--accent-blue)";
  return "bg-(--border)";
}

function resolveTextTone(thread: ThreadSectionLinkedThreadState | null): string {
  if (!thread) return "text-(--foreground-tertiary)";
  if (thread.archived) return "text-(--foreground-tertiary)";
  if (thread.statusType === "systemError") return "text-(--red-text)";
  if (thread.statusActiveFlags.length > 0) return "text-(--orange-text)";
  if (thread.statusType === "active") return "text-(--accent-blue)";
  return "text-(--foreground-secondary)";
}

function deriveFallbackLabel(blockId: string): string {
  return `Section ${blockId.slice(0, 4)}`;
}

function StatusIcon({
  thread,
  pending,
}: {
  thread: ThreadSectionLinkedThreadState | null;
  pending: boolean;
}) {
  if (pending) return <ActivitySpinnerIcon className="size-3" />;
  if (thread?.statusType === "active") return <PlayIcon className="size-3" />;
  return null;
}

function buildPillText(stateLabel: string, timeLabel: string, label: string): string {
  const parts: string[] = [];
  if (label) parts.push(label);
  parts.push(stateLabel);
  if (timeLabel) parts.push(timeLabel);
  return parts.join(" · ");
}

export interface ThreadSectionRowProps {
  blockId: string;
  label: string;
  threadId: string;
  thread: ThreadSectionLinkedThreadState | null;
  pending: boolean;
  canOpenThread: boolean;
  canSend: boolean;
  onLabelChange: (label: string) => void;
  onOpenThread?: (threadId: string) => void;
  onSend?: (blockId: string, anchor: HTMLElement) => void;
}

export function ThreadSectionRow({
  blockId,
  label,
  threadId,
  thread,
  pending,
  canOpenThread,
  canSend,
  onLabelChange,
  onOpenThread,
  onSend,
}: ThreadSectionRowProps) {
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [draftLabel, setDraftLabel] = useState(() => normalizeString(label));
  const inputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const threadName = thread?.threadName?.trim() || thread?.threadPreview?.trim() || threadId;
  const labelPlaceholder = useMemo(() => deriveFallbackLabel(blockId), [blockId]);
  const stateLabel = resolveThreadStateLabel(thread);
  const timeLabel = formatRelativeTime(thread?.updatedAt ?? 0, now);
  const lineTone = resolveLineTone(thread);
  const textTone = resolveTextTone(thread);
  const pillText = buildPillText(stateLabel, timeLabel, label);

  useEffect(() => {
    if (isEditingLabel) return;
    setDraftLabel(label);
  }, [isEditingLabel, label]);

  useEffect(() => {
    if (!thread || thread.statusType !== "active") return undefined;
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [thread]);

  useEffect(() => {
    if (!isEditingLabel) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [isEditingLabel]);

  const commitDraftLabel = () => {
    const nextLabel = draftLabel.trim();
    if (nextLabel === label) {
      setIsEditingLabel(false);
      return;
    }
    onLabelChange(nextLabel);
    setIsEditingLabel(false);
  };

  return (
    <section className="w-full py-0" contentEditable={false}>
      <div className="group/sec relative flex w-full items-center gap-0">
        <div className={cn("h-[1.5px] flex-1 rounded-full", lineTone)} />

        <div
          className={cn(
            "relative z-10 flex items-center gap-1.5 px-3 py-1",
            "rounded-full text-[11px] font-medium leading-none whitespace-nowrap",
            "transition-all duration-200",
            textTone,
          )}
        >
          <StatusIcon thread={thread} pending={pending} />
          <NodexTooltip tooltipContent={label ? `Double-click to rename "${label}"` : undefined}>
            <span
              className={cn(label && "cursor-text")}
              onDoubleClick={() => setIsEditingLabel(true)}
            >
              {pillText}
            </span>
          </NodexTooltip>

          <div
            className={cn(
              "flex max-w-0 items-center gap-1 overflow-hidden opacity-0",
              "transition-all duration-200",
              "group-hover/sec:max-w-80 group-hover/sec:opacity-100",
            )}
          >
            {threadName && (
              <>
                <span>·</span>
                <NodexTooltip tooltipContent={threadName}>
                  <span className="max-w-32 truncate">{threadName}</span>
                </NodexTooltip>
              </>
            )}

            {canOpenThread && onOpenThread ? (
              <button
                type="button"
                className="rounded-full px-1.5 py-0.5 text-[11px] font-medium text-(--foreground-tertiary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
                onClick={() => onOpenThread(threadId)}
              >
                Open
              </button>
            ) : null}

            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                "bg-(--foreground) text-(--background)",
                "hover:opacity-90 disabled:opacity-40",
              )}
              disabled={!canSend || pending || !onSend}
              onClick={(event) => onSend?.(blockId, event.currentTarget)}
            >
              <SendHorizontal className="size-2.5" />
              Send
            </button>
          </div>
        </div>

        <div className={cn("h-[1.5px] flex-1 rounded-full", lineTone)} />

        {isEditingLabel ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-(--background)">
            <div className="h-[1.5px] flex-1 rounded-full bg-(--border)" />
            <input
              ref={inputRef}
              value={draftLabel}
              placeholder={labelPlaceholder}
              onChange={(event) => setDraftLabel(event.target.value)}
              onBlur={commitDraftLabel}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDraftLabel();
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraftLabel(label);
                  setIsEditingLabel(false);
                }
              }}
              className={cn(
                "mx-1 w-32 rounded-full border border-(--border) bg-(--background) px-3 py-1",
                "text-center text-[11px] font-medium text-(--foreground) outline-none",
                "placeholder:text-(--foreground-tertiary)",
              )}
            />
            <div className="h-[1.5px] flex-1 rounded-full bg-(--border)" />
          </div>
        ) : null}
      </div>
    </section>
  );
}
