import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../../../../lib/utils";

export type ToolRenderStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "interrupted"
  | string
  | undefined;

/* ------------------------------------------------------------------ */
/*  InlineToolToggle                                                   */
/* ------------------------------------------------------------------ */

interface InlineToolToggleProps {
  /** Primary label text (rendered as uppercase text). */
  label: string;
  /** Optional leading phrase rendered with stronger emphasis than the trailing detail. */
  leadingLabel?: string;
  /** Optional secondary text after the label (e.g. diff stats). */
  subtitle?: ReactNode;
  /** Render the label in monospace font (e.g. for filenames). */
  monoLabel?: boolean;
  status?: ToolRenderStatus;
  defaultExpanded?: boolean;
  /** Automatically expand after the item has remained in-progress for the given delay. */
  autoExpandDelayMs?: number;
  /** Auto-collapse when status transitions from in-progress to a settled state. */
  collapseWhenStatusSettles?: boolean;
  /** Optional delay before auto-collapsing after the item settles. */
  settleCollapseDelayMs?: number;
  children?: ReactNode;
}

function statusSuffix(status: ToolRenderStatus): ReactNode {
  if (!status) return null;
  if (status === "completed" || status === "inProgress") return null;

  /* Failed → ✕ circle, Interrupted → stop, Declined → circle-slash */
  const icon =
    status === "failed" ? (
      /* x-circle */
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ) : status === "interrupted" ? (
      /* stop-circle */
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
        <rect x="5.75" y="5.75" width="4.5" height="4.5" rx="0.75" fill="currentColor" />
      </svg>
    ) : status === "declined" ? (
      /* circle-slash */
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.6 12.4L12.4 3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ) : null;

  /* For unknown string statuses, fall back to dot + text */
  if (!icon) {
    return (
      <span className="ml-1 shrink-0 text-xs font-medium text-(--foreground-tertiary)">
        · {status}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "ml-1 inline-flex shrink-0 items-center",
        (status === "failed" || status === "interrupted") && "text-(--red-text)",
        status === "declined" && "text-(--foreground-tertiary)",
      )}
      title={status === "failed" ? "Failed" : status === "interrupted" ? "Interrupted" : "Declined"}
    >
      {icon}
    </span>
  );
}

interface SplitInlineToolLabel {
  leading: string;
  trailing: string | null;
}

export function shouldShimmerInlineToolLeadingLabel(
  status: ToolRenderStatus,
  leadingLabel: string | undefined,
): boolean {
  if (status !== "inProgress") return false;
  if (!leadingLabel) return false;
  return leadingLabel.trim().length > 0;
}

const IN_PROGRESS_LEADING_LABEL_MAP: Record<string, string> = {
  called: "calling",
  explored: "exploring",
  ran: "running",
  "ran command": "running command",
  edited: "editing",
  "searched web": "searching web",
};

function matchLeadingLabelCase(input: string, replacement: string): string {
  if (input.length === 0) return replacement;
  if (input === input.toUpperCase()) return replacement.toUpperCase();
  if (input === input.toLowerCase()) return replacement;
  const first = input[0];
  if (!first) return replacement;
  if (first === first.toUpperCase()) {
    return `${replacement[0]?.toUpperCase() ?? ""}${replacement.slice(1)}`;
  }
  return replacement;
}

export function resolveInlineToolLeadingLabel(
  leadingLabel: string,
  status: ToolRenderStatus,
): string {
  if (status !== "inProgress") return leadingLabel;

  const normalized = leadingLabel.trim();
  if (normalized.length === 0) return leadingLabel;

  const next = IN_PROGRESS_LEADING_LABEL_MAP[normalized.toLowerCase()];
  if (!next) return leadingLabel;
  return matchLeadingLabelCase(leadingLabel, next);
}

export function shouldCollapseInlineToolOnStatusSettle(
  previousStatus: ToolRenderStatus,
  nextStatus: ToolRenderStatus,
): boolean {
  if (previousStatus !== "inProgress") return false;
  return nextStatus !== "inProgress";
}

export function splitInlineToolLabel(label: string, leadingLabel: string | undefined): SplitInlineToolLabel {
  if (!leadingLabel) {
    return { leading: label, trailing: null };
  }

  const normalizedLeading = leadingLabel.trim();
  if (normalizedLeading.length === 0) {
    return { leading: label, trailing: null };
  }

  if (!label.startsWith(normalizedLeading)) {
    return { leading: label, trailing: null };
  }

  const suffix = label.slice(normalizedLeading.length);
  if (suffix.length === 0) {
    return { leading: normalizedLeading, trailing: null };
  }

  const normalizedTrailing = suffix.replace(/^[:\s-]+/, "").trim();
  if (normalizedTrailing.length === 0) {
    return { leading: normalizedLeading, trailing: null };
  }

  return { leading: normalizedLeading, trailing: normalizedTrailing };
}

export function InlineToolToggle({
  label,
  leadingLabel,
  subtitle,
  monoLabel,
  status,
  defaultExpanded = false,
  autoExpandDelayMs,
  collapseWhenStatusSettles = false,
  settleCollapseDelayMs,
  children,
}: InlineToolToggleProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previousStatusRef = useRef<ToolRenderStatus>(status);
  const hasBody = Boolean(children);
  const splitLabel = useMemo(
    () => splitInlineToolLabel(label, leadingLabel),
    [label, leadingLabel],
  );
  const hasTrailingLabel = Boolean(splitLabel.trailing);
  const shouldShimmerLeadingLabel = shouldShimmerInlineToolLeadingLabel(status, leadingLabel);
  const renderedLeadingLabel = resolveInlineToolLeadingLabel(splitLabel.leading, status);

  useEffect(() => {
    if (!hasBody) return;
    if (status !== "inProgress") return;
    if (autoExpandDelayMs === undefined) return;

    const timeoutId = window.setTimeout(() => {
      setExpanded(true);
    }, autoExpandDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [autoExpandDelayMs, hasBody, status]);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;

    if (!collapseWhenStatusSettles) return;
    if (!shouldCollapseInlineToolOnStatusSettle(previousStatus, status)) return;

    if (!settleCollapseDelayMs) {
      setExpanded(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setExpanded(false);
    }, settleCollapseDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [collapseWhenStatusSettles, settleCollapseDelayMs, status]);

  return (
    <div>
      <button
        type="button"
        className="group -ml-1 inline-flex max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-sm transition-colors hover:bg-(--background-secondary) focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:outline-none"
        aria-expanded={expanded}
        onClick={() => {
          if (!hasBody) return;
          setExpanded((prev) => !prev);
        }}
      >
        <span
          className={cn(
            "truncate",
            hasTrailingLabel
              ? "text-token-description-foreground/90 transition-colors group-hover:text-token-foreground"
              : "text-(--foreground-secondary) transition-colors group-hover:text-(--foreground)",
            monoLabel && "font-mono",
          )}
        >
          <span
            className={cn(
              "codex-tool-leading-label text-token-description-foreground/90 transition-colors group-hover:text-token-foreground",
              shouldShimmerLeadingLabel && "codex-tool-leading-label--in-progress",
            )}
          >
            {renderedLeadingLabel}
          </span>
          {hasTrailingLabel && (
            <span className="text-token-foreground/40 transition-colors group-hover:text-token-foreground">
              {" "}
              {splitLabel.trailing}
            </span>
          )}
        </span>
        {subtitle && (
          <span className="shrink-0">{subtitle}</span>
        )}
        {statusSuffix(status)}
        {hasBody && (
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex size-3 shrink-0 items-center justify-center text-(--foreground-tertiary) transition-all duration-150",
              expanded
                ? "rotate-90 opacity-100"
                : "rotate-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            <svg viewBox="0 0 12 12" fill="none" className="size-3">
              <path
                d="M4 2.5L8 6L4 9.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        )}
      </button>

      {expanded && hasBody ? (
        <div className="codex-tool-toggle-body mt-0.5 rounded-md border border-(--border) bg-(--background-secondary) px-2 py-1 text-xs text-(--foreground-secondary)">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared primitives (kept for expanded body sections)                */
/* ------------------------------------------------------------------ */

export function DetailLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">{children}</div>;
}

export function ToolJsonDetail({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  return (
    <div className="mb-2">
      <DetailLabel>{label}</DetailLabel>
      <JsonBlock value={value} />
    </div>
  );
}

export function ToolErrorDetail({
  error,
  className,
  showLabel = true,
}: {
  error: string;
  className?: string;
  showLabel?: boolean;
}) {
  return (
    <div className={className}>
      {showLabel ? <DetailLabel>Error</DetailLabel> : null}
      <div className="rounded-md border border-(--destructive)/35 bg-(--destructive)/10 px-2.5 py-2 text-xs text-(--destructive)">
        {error}
      </div>
    </div>
  );
}

export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "codex-tool-code scrollbar-token max-h-80 overflow-auto rounded-md border border-(--border) bg-(--background) px-2.5 py-2 font-mono text-xs/normal wrap-break-word whitespace-pre-wrap",
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  return <CodeBlock>{text}</CodeBlock>;
}
