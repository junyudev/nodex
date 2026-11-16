import { getIntl, useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { ChevronRightIcon } from "@/components/shared/icons";
import { RotateCcw } from "@/components/shared/icons/generic-icons";
import { cn } from "@/lib/utils";
import { useId, useRef, useState } from "react";

import type {
  CodexRateLimitResetCredit,
  CodexRateLimitResetCreditsSummary,
  CodexRateLimitResetInput,
  CodexRateLimitResetResult,
} from "../../../../lib/types";

export function formatQuotaResetCreditExpiration(
  expiresAt: number | null,
  locale?: string,
  now: number = Date.now(),
  intl = getIntl(),
): string {
  if (expiresAt === null)
    return intl.formatMessage({
      id: "conversation.authRateLimits.noExpiration",
      defaultMessage: "Doesn’t expire",
    });

  const expiresAtMs = expiresAt * 1_000;
  const sameYear = new Date(expiresAtMs).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(locale ?? intl.locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(expiresAtMs);
  return intl.formatMessage(
    { id: "conversation.authRateLimits.expires", defaultMessage: "Expires {date}" },
    { date },
  );
}

export function findAvailableQuotaResetCredit(
  summary: CodexRateLimitResetCreditsSummary,
): CodexRateLimitResetCredit | null {
  return summary.credits?.find((credit) => credit.status === "available") ?? null;
}

export function formatQuotaResetAvailability(availableCount: number, intl = getIntl()): string {
  return intl.formatMessage(
    {
      id: "conversation.authRateLimits.available",
      defaultMessage: "{count, plural, one {# quota reset} other {# quota resets}}",
    },
    { count: availableCount },
  );
}

function quotaResetOutcomeMessage(
  result: CodexRateLimitResetResult,
  intl: ReturnType<typeof useIntl>,
): string {
  if (result.outcome === "nothingToReset") {
    return intl.formatMessage({
      id: "conversation.authRateLimits.noResetNeeded",
      defaultMessage: "Your current quota doesn’t need a reset.",
    });
  }
  if (result.outcome === "noCredit") {
    return intl.formatMessage({
      id: "conversation.authRateLimits.noResetAvailable",
      defaultMessage: "No quota resets are available.",
    });
  }

  const remaining = result.account.rateLimitResetCredits?.availableCount ?? 0;
  return intl.formatMessage(
    {
      id: "conversation.authRateLimits.quotaReset",
      defaultMessage: "Quota reset. {remaining, plural, other {# remaining}}.",
    },
    { remaining },
  );
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
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<
    { kind: "error" } | { kind: "status"; result: CodexRateLimitResetResult } | null
  >(null);
  const attemptRef = useRef<{ idempotencyKey: string; creditId: string | null } | null>(null);
  const contentId = useId();

  // Keep the outcome of spending the last credit visible until the card closes.
  if (!summary || (summary.availableCount <= 0 && !message)) return null;

  const activeCredit = findAvailableQuotaResetCredit(summary);
  const expiration = activeCredit
    ? formatQuotaResetCreditExpiration(activeCredit.expiresAt, intl.locale, undefined, intl)
    : null;

  const handleReset = async () => {
    if (pending || summary.availableCount <= 0) return;

    const attempt = attemptRef.current ?? {
      idempotencyKey: crypto.randomUUID(),
      creditId: activeCredit?.id ?? null,
    };
    attemptRef.current = attempt;
    setPending(true);
    setMessage(null);

    return runWithCleanup(
      async () => {
        const result = await onReset({
          idempotencyKey: attempt.idempotencyKey,
          ...(attempt.creditId ? { creditId: attempt.creditId } : {}),
        });
        attemptRef.current = null;
        setMessage({ kind: "status", result });
      },
      {
        onError: () => {
          setMessage({ kind: "error" });
        },
        cleanup: () => {
          setPending(false);
        },
      },
    );
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
          {formatQuotaResetAvailability(summary.availableCount, intl)}
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
              {pending
                ? intl.formatMessage({
                    id: "conversation.authRateLimits.resetting",
                    defaultMessage: "Resetting…",
                  })
                : intl.formatMessage({
                    id: "conversation.authRateLimits.reset",
                    defaultMessage: "Reset quota",
                  })}
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
              {message.kind === "error"
                ? intl.formatMessage({
                    id: "conversation.authRateLimits.resetFailed",
                    defaultMessage: "Couldn’t reset quota. Try again.",
                  })
                : quotaResetOutcomeMessage(message.result, intl)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
