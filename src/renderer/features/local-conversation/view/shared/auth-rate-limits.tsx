import { ChevronRightIcon } from "@/components/shared/icons";
import { RotateCcw } from "@/components/shared/icons/generic-icons";
import { cn } from "@/lib/utils";
import { useId, useRef, useState } from "react";

import type {
  CodexAccountSnapshot,
  CodexRateLimitResetCredit,
  CodexRateLimitResetCreditsSummary,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
  CodexRateLimitsSnapshot,
} from "../../../../lib/types";

/** One quota window, shared by the rail ring and the account card so their colors agree. */
export interface RateLimitWindowView {
  label: string;
  remainingPercent: number;
  windowDurationMins: number;
  resetsAtLabel: string | null;
  color: string;
}

export interface RateLimitViewModel {
  /** Shortest window first; at most two. */
  windows: readonly RateLimitWindowView[];
  outer: RateLimitWindowView | null;
  inner: RateLimitWindowView | null;
  ariaLabel: string;
  hasLimits: boolean;
}

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;
const MS_PER_DAY = MINUTES_PER_DAY * 60 * 1_000;

export function formatRateLimitWindowLabel(windowDurationMins?: number): string | null {
  if (!windowDurationMins || windowDurationMins <= 0) return null;

  const minutes = Math.round(windowDurationMins);
  if (minutes >= MINUTES_PER_WEEK) {
    const weeks = Math.max(1, Math.round(minutes / MINUTES_PER_WEEK));
    return weeks === 1 ? "Weekly" : `${weeks}-week`;
  }
  if (minutes >= MINUTES_PER_DAY) {
    const days = Math.round(minutes / MINUTES_PER_DAY);
    return days === 1 ? "Daily" : `${days}-day`;
  }
  if (minutes >= MINUTES_PER_HOUR) return `${Math.round(minutes / MINUTES_PER_HOUR)}-hour`;
  return `${minutes}-minute`;
}

/**
 * Names a reset moment as precisely as it needs to be: a time today, a weekday and time within
 * the coming week, otherwise a date.
 */
export function formatRateLimitResetLabel(
  resetsAt?: number,
  now: number = Date.now(),
  locale?: string,
): string | null {
  if (!resetsAt) return null;
  if (resetsAt <= now) return "now";

  const time = { hour: "numeric", minute: "2-digit" } as const;
  if (new Date(resetsAt).toDateString() === new Date(now).toDateString()) {
    return new Intl.DateTimeFormat(locale, time).format(resetsAt);
  }
  if (resetsAt - now < 6 * MS_PER_DAY) {
    return new Intl.DateTimeFormat(locale, { weekday: "short", ...time }).format(resetsAt);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(resetsAt);
}

export function formatQuotaResetCreditExpiration(
  expiresAt: number | null,
  locale?: string,
  now: number = Date.now(),
): string {
  if (expiresAt === null) return "Doesn’t expire";

  const expiresAtMs = expiresAt * 1_000;
  const sameYear = new Date(expiresAtMs).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(expiresAtMs);
  return `Expires ${date}`;
}

export function findAvailableQuotaResetCredit(
  summary: CodexRateLimitResetCreditsSummary,
): CodexRateLimitResetCredit | null {
  return summary.credits?.find((credit) => credit.status === "available") ?? null;
}

export function formatQuotaResetAvailability(availableCount: number): string {
  return availableCount === 1 ? "1 quota reset" : `${availableCount} quota resets`;
}

export function getRemainingRateLimitPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function resolveQuotaColor(remainingPercent: number, fallback: string): string {
  if (remainingPercent <= 15) return "var(--red-text)";
  if (remainingPercent <= 35) return "var(--yellow-text)";
  return fallback;
}

function buildRateLimitWindowView(
  window: CodexRateLimitsSnapshot["primary"],
  now: number,
): Omit<RateLimitWindowView, "color"> | null {
  const label = formatRateLimitWindowLabel(window?.windowDurationMins);
  if (!window?.windowDurationMins || !label) return null;

  return {
    label,
    remainingPercent: getRemainingRateLimitPercent(window.usedPercent),
    windowDurationMins: window.windowDurationMins,
    resetsAtLabel: formatRateLimitResetLabel(window.resetsAt, now),
  };
}

export function buildRateLimitViewModel(
  rateLimits: CodexAccountSnapshot["rateLimits"] | undefined,
  now: number = Date.now(),
): RateLimitViewModel {
  const sorted = [
    buildRateLimitWindowView(rateLimits?.primary, now),
    buildRateLimitWindowView(rateLimits?.secondary, now),
  ]
    .filter((window) => window !== null)
    .sort((left, right) => left.windowDurationMins - right.windowDurationMins);

  const shortest = sorted[0];
  const longest = sorted.length > 1 ? sorted[sorted.length - 1] : undefined;
  const outer = shortest
    ? {
        ...shortest,
        color: resolveQuotaColor(shortest.remainingPercent, "var(--color-token-charts-blue)"),
      }
    : null;
  const inner = longest
    ? {
        ...longest,
        color: resolveQuotaColor(longest.remainingPercent, "var(--color-token-charts-green)"),
      }
    : null;
  const windows = [outer, inner].filter((window) => window !== null);
  const ariaParts = windows.map(
    (window) => `${window.label.toLowerCase()} ${window.remainingPercent}%`,
  );

  return {
    windows,
    outer,
    inner,
    ariaLabel:
      ariaParts.length > 0
        ? `Usage remaining: ${ariaParts.join(", ")}`
        : "Usage remaining unavailable",
    hasLimits: windows.length > 0,
  };
}

function RateLimitWindowMeter({ window }: { window: RateLimitWindowView }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5 text-xs text-token-description-foreground">
        <span className="text-sm font-medium text-token-foreground">{window.label}</span>
        {window.resetsAtLabel ? <span>Resets {window.resetsAtLabel}</span> : null}
        <span className="ml-auto tabular-nums">
          <span className="text-sm font-medium text-token-foreground">
            {window.remainingPercent}%
          </span>{" "}
          left
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${window.label} usage remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.remainingPercent}
        className="h-1 overflow-hidden rounded-full bg-token-foreground/10"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${window.remainingPercent}%`, backgroundColor: window.color }}
        />
      </div>
    </div>
  );
}

export function RateLimitTooltipSection({
  rateLimits,
  quotaResetCredits,
  onQuotaReset,
}: {
  rateLimits: CodexAccountSnapshot["rateLimits"] | undefined;
  quotaResetCredits?: CodexRateLimitResetCreditsSummary | null;
  onQuotaReset?: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
}) {
  const { windows } = buildRateLimitViewModel(rateLimits);
  const hasQuotaReset = Boolean(quotaResetCredits?.availableCount && onQuotaReset);
  if (windows.length === 0 && !hasQuotaReset) return null;

  return (
    <section
      aria-label="Usage remaining"
      className="flex flex-col gap-3 border-t border-token-border p-3"
    >
      {windows.map((window) => (
        <RateLimitWindowMeter key={window.label} window={window} />
      ))}
      {quotaResetCredits && onQuotaReset ? (
        <QuotaResetTooltipSection summary={quotaResetCredits} onReset={onQuotaReset} />
      ) : null}
    </section>
  );
}

function quotaResetOutcomeMessage(result: CodexRateLimitResetResult): string {
  if (result.outcome === "nothingToReset") {
    return "Your current quota doesn’t need a reset.";
  }
  if (result.outcome === "noCredit") {
    return "No quota resets are available.";
  }

  const remaining = result.account.rateLimitResetCredits?.availableCount ?? 0;
  return `Quota reset. ${remaining} remaining.`;
}

/**
 * Spending a reset credit is deliberate: the action stays behind a disclosure so a pointer
 * crossing the hover card cannot consume one.
 */
export function QuotaResetTooltipSection({
  summary,
  onReset,
}: {
  summary: CodexRateLimitResetCreditsSummary | null | undefined;
  onReset: (input: CodexRateLimitResetInput) => Promise<CodexRateLimitResetResult>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "status"; text: string } | null>(null);
  const attemptRef = useRef<{ idempotencyKey: string; creditId: string | null } | null>(null);
  const contentId = useId();

  // Keep the outcome of spending the last credit visible until the card closes.
  if (!summary || (summary.availableCount <= 0 && !message)) return null;

  const activeCredit = findAvailableQuotaResetCredit(summary);
  const expiration = activeCredit ? formatQuotaResetCreditExpiration(activeCredit.expiresAt) : null;

  const handleReset = async () => {
    if (pending || summary.availableCount <= 0) return;

    const attempt = attemptRef.current ?? {
      idempotencyKey: crypto.randomUUID(),
      creditId: activeCredit?.id ?? null,
    };
    attemptRef.current = attempt;
    setPending(true);
    setMessage(null);

    try {
      const result = await onReset({
        idempotencyKey: attempt.idempotencyKey,
        ...(attempt.creditId ? { creditId: attempt.creditId } : {}),
      });
      attemptRef.current = null;
      setMessage({ kind: "status", text: quotaResetOutcomeMessage(result) });
    } catch {
      setMessage({ kind: "error", text: "Couldn’t reset quota. Try again." });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="-mx-1.5 flex flex-col">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={expanded}
        className="flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-sm text-token-foreground outline-none hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-(--ring)/35"
        onClick={() => setExpanded((current) => !current)}
      >
        <RotateCcw aria-hidden="true" className="size-3.5 shrink-0 text-token-text-secondary" />
        <span className="min-w-0 flex-1 truncate">
          {formatQuotaResetAvailability(summary.availableCount)}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-token-description-foreground",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded ? (
        <div id={contentId} className="flex flex-col gap-1.5 pt-1 pr-1.5 pl-7">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-token-description-foreground tabular-nums">
              {expiration}
            </span>
            <button
              type="button"
              disabled={pending || summary.availableCount <= 0}
              className="h-6 shrink-0 rounded-md bg-token-foreground/5 px-2 text-xs font-medium text-token-foreground outline-none hover:bg-token-foreground/10 focus-visible:ring-2 focus-visible:ring-(--ring)/35 disabled:opacity-40"
              onClick={() => void handleReset()}
            >
              {pending ? "Resetting…" : "Reset quota"}
            </button>
          </div>
          {message ? (
            <p
              aria-live="polite"
              className={cn(
                "m-0 text-xs",
                message.kind === "error"
                  ? "text-token-error-foreground"
                  : "text-token-text-secondary",
              )}
            >
              {message.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
