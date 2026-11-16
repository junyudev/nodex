import { FormattedMessage, useIntl, type IntlShape } from "@/lib/i18n";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "../../../../lib/utils";
import type { CodexAccountSnapshot } from "@/lib/types";
import type { ContextWindowIndicatorState } from "@/lib/context-window";

const PROMPT_TEXTAREA_MAX_VIEWPORT_RATIO = 0.25;
const FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX = 220;
const CONTEXT_RING_RADIUS = 5;

export function resolvePromptTextareaMaxHeightPx(): number {
  if (typeof window === "undefined") return FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX;

  const maxHeightPx = Math.floor(window.innerHeight * PROMPT_TEXTAREA_MAX_VIEWPORT_RATIO);
  if (!Number.isFinite(maxHeightPx) || maxHeightPx <= 0) {
    return FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX;
  }

  return maxHeightPx;
}

function formatRoundedTokenThousands(intl: IntlShape, value: number | null): string {
  const thousands =
    value != null && Number.isFinite(value) ? Math.max(0, Math.round(value / 1_000)) : 0;
  return intl.formatMessage(
    { id: "conversation.contextWindow.thousands", defaultMessage: "{count, number}k" },
    { count: thousands },
  );
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function shouldShowAutoCompactionNote(account: CodexAccountSnapshot | null): boolean {
  return account?.account?.type === "chatgpt";
}

export function ContextWindowTooltipContent({
  state,
  showAutoCompactionNote,
}: {
  state: ContextWindowIndicatorState;
  showAutoCompactionNote: boolean;
}) {
  const intl = useIntl();
  if (state.status !== "ready") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="whitespace-pre-line text-token-input-placeholder-foreground">
          <FormattedMessage
            id="conversation.contextWindow.title"
            defaultMessage="Context window:"
          />
        </span>
        <span>
          {state.status === "usageOnly"
            ? intl.formatMessage(
                {
                  id: "conversation.contextWindow.usedTokens",
                  defaultMessage: "{count, plural, other {# tokens used}}",
                },
                { count: normalizeTokenCount(state.usedTokens) },
              )
            : intl.formatMessage({
                id: "conversation.contextWindow.usageUnavailable",
                defaultMessage: "Usage unavailable",
              })}
        </span>
      </div>
    );
  }

  const remainingPercent = Math.max(0, 100 - state.percentFull);
  const isFullLabel = state.percentFull >= 50;
  const usedPercent = intl.formatNumber(state.percentFull / 100, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const leftPercent = intl.formatNumber(remainingPercent / 100, {
    style: "percent",
    maximumFractionDigits: 2,
  });

  return (
    <div className="flex w-38 flex-col gap-0.5 text-center">
      <span className="whitespace-pre-line text-token-input-placeholder-foreground">
        <FormattedMessage id="conversation.contextWindow.title" defaultMessage="Context window:" />
      </span>
      <span className={isFullLabel ? "text-token-input-placeholder-foreground" : undefined}>
        {isFullLabel
          ? intl.formatMessage(
              { id: "conversation.contextWindow.full", defaultMessage: "{usedPercent} full" },
              { usedPercent },
            )
          : intl.formatMessage(
              {
                id: "conversation.contextWindow.usedAndLeft",
                defaultMessage: "{usedPercent} used ({leftPercent} left)",
              },
              { usedPercent, leftPercent },
            )}
      </span>
      <span>
        {intl.formatMessage(
          {
            id: "conversation.contextWindow.tokensOfCapacity",
            defaultMessage: "{used} / {capacity} tokens used",
          },
          {
            used: formatRoundedTokenThousands(intl, state.usedTokens),
            capacity: formatRoundedTokenThousands(intl, state.windowTokens),
          },
        )}
      </span>
      {showAutoCompactionNote ? (
        <p className="mt-2 font-medium">
          <FormattedMessage
            id="conversation.contextWindow.autoCompact"
            defaultMessage="Nodex automatically compacts its context"
          />
        </p>
      ) : null}
    </div>
  );
}

function contextWindowAriaLabel(intl: IntlShape, state: ContextWindowIndicatorState): string {
  if (state.status === "ready") {
    const usedPercent = intl.formatNumber(state.percentFull / 100, {
      style: "percent",
      maximumFractionDigits: 2,
    });
    const used = intl.formatNumber(normalizeTokenCount(state.usedTokens));
    const capacity = intl.formatNumber(normalizeTokenCount(state.windowTokens));
    if (state.percentFull >= 50) {
      return intl.formatMessage(
        {
          id: "conversation.contextWindow.fullAriaLabel",
          defaultMessage: "Context window {usedPercent} full, {used} of {capacity} tokens used",
        },
        { usedPercent, used, capacity },
      );
    }

    return intl.formatMessage(
      {
        id: "conversation.contextWindow.usedAndLeftAriaLabel",
        defaultMessage:
          "Context window {usedPercent} used, {leftPercent} left, {used} of {capacity} tokens used",
      },
      {
        usedPercent,
        leftPercent: intl.formatNumber(Math.max(0, 100 - state.percentFull) / 100, {
          style: "percent",
          maximumFractionDigits: 2,
        }),
        used,
        capacity,
      },
    );
  }

  return state.status === "usageOnly"
    ? intl.formatMessage(
        {
          id: "conversation.contextWindow.unknownCapacityAriaLabel",
          defaultMessage: "Context window {used} tokens used, capacity unavailable",
        },
        { used: intl.formatNumber(normalizeTokenCount(state.usedTokens)) },
      )
    : intl.formatMessage({
        id: "conversation.contextWindow.usageUnavailableAriaLabel",
        defaultMessage: "Context window usage unavailable",
      });
}

export function ContextWindowIndicator({
  state,
  account,
  className,
  showFallbackLabel = true,
}: {
  state: ContextWindowIndicatorState;
  account: CodexAccountSnapshot | null;
  className?: string;
  showFallbackLabel?: boolean;
}) {
  const intl = useIntl();
  const dashOffset = state.status === "ready" ? Math.max(0, 100 - state.percentFull) : 100;
  const shouldShowFallbackLabel = showFallbackLabel && state.status !== "ready";
  const showAutoCompaction = shouldShowAutoCompactionNote(account);
  const ring = (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
      <circle
        cx="6"
        cy="6"
        r={CONTEXT_RING_RADIUS}
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        opacity="0.16"
      />
      <circle
        cx="6"
        cy="6"
        r={CONTEXT_RING_RADIUS}
        stroke="currentColor"
        strokeWidth="2"
        opacity={state.status === "ready" ? 1 : 0}
        strokeLinecap="round"
        fill="none"
        pathLength="100"
        strokeDasharray="100"
        strokeDashoffset={dashOffset}
        className=""
        transform="rotate(-90 6 6)"
        style={{
          transition: "stroke-dashoffset 120ms ease-out, opacity 120ms ease-out",
        }}
      />
    </svg>
  );

  return (
    <NodexTooltip
      tooltipContent={
        <ContextWindowTooltipContent state={state} showAutoCompactionNote={showAutoCompaction} />
      }
      side="top"
    >
      {!showFallbackLabel ? (
        <span
          aria-label={contextWindowAriaLabel(intl, state)}
          className={cn(
            "icon-xs inline-flex items-center justify-center text-token-description-foreground",
            className,
          )}
          role="img"
        >
          {ring}
        </span>
      ) : (
        <button
          type="button"
          aria-label={contextWindowAriaLabel(intl, state)}
          className={cn(
            "ml-2 inline-flex items-center gap-1 rounded-full text-token-description-foreground outline-none focus-visible:ring-2 focus-visible:ring-(--ring)",
            className,
          )}
        >
          {ring}
          {shouldShowFallbackLabel ? (
            <span className="composer-footer__label--sm select-none whitespace-nowrap text-sm text-token-input-placeholder-foreground opacity-60">
              {state.status === "usageOnly"
                ? formatRoundedTokenThousands(intl, state.usedTokens)
                : "—"}
            </span>
          ) : null}
        </button>
      )}
    </NodexTooltip>
  );
}
