import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "../../../../lib/utils";
import type { CodexAccountSnapshot } from "@/lib/types";
import type { ContextWindowIndicatorState } from "@/lib/context-window";

const PROMPT_TEXTAREA_MAX_VIEWPORT_RATIO = 0.25;
const FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX = 220;
const CONTEXT_RING_RADIUS = 5;
const WHOLE_TOKEN_FORMATTER = new Intl.NumberFormat("en-US");

export function resolvePromptTextareaMaxHeightPx(): number {
  if (typeof window === "undefined") return FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX;

  const maxHeightPx = Math.floor(window.innerHeight * PROMPT_TEXTAREA_MAX_VIEWPORT_RATIO);
  if (!Number.isFinite(maxHeightPx) || maxHeightPx <= 0) {
    return FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX;
  }

  return maxHeightPx;
}

function formatRoundedTokenThousands(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "0k";
  return `${Math.max(0, Math.round(value / 1_000))}k`;
}

function formatWholeTokenCount(value: number): string {
  const normalizedValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return WHOLE_TOKEN_FORMATTER.format(normalizedValue);
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
  if (state.status !== "ready") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="whitespace-pre-line text-token-input-placeholder-foreground">
          Context window:
        </span>
        <span>
          {state.status === "usageOnly"
            ? `${formatWholeTokenCount(state.usedTokens)} tokens used`
            : "Usage unavailable"}
        </span>
      </div>
    );
  }

  const remainingPercent = Math.max(0, 100 - state.percentFull);
  const isFullLabel = state.percentFull >= 50;

  return (
    <div className="flex w-38 flex-col gap-0.5 text-center">
      <span className="whitespace-pre-line text-token-input-placeholder-foreground">
        Context window:
      </span>
      <span className={isFullLabel ? "text-token-input-placeholder-foreground" : undefined}>
        {isFullLabel
          ? `${state.percentFull}% full`
          : `${state.percentFull}% used (${remainingPercent}% left)`}
      </span>
      <span>
        {formatRoundedTokenThousands(state.usedTokens)} /{" "}
        {formatRoundedTokenThousands(state.windowTokens)} tokens used
      </span>
      {showAutoCompactionNote ? (
        <p className="mt-2 font-medium">Nodex automatically compacts its context</p>
      ) : null}
    </div>
  );
}

function contextWindowAriaLabel(state: ContextWindowIndicatorState): string {
  if (state.status === "ready") {
    if (state.percentFull >= 50) {
      return `Context window ${state.percentFull}% full, ${formatWholeTokenCount(state.usedTokens)} of ${formatWholeTokenCount(state.windowTokens)} tokens used`;
    }

    return `Context window ${state.percentFull}% used, ${Math.max(0, 100 - state.percentFull)}% left, ${formatWholeTokenCount(state.usedTokens)} of ${formatWholeTokenCount(state.windowTokens)} tokens used`;
  }

  return state.status === "usageOnly"
    ? `Context window ${formatWholeTokenCount(state.usedTokens)} tokens used, capacity unavailable`
    : "Context window usage unavailable";
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
          aria-label={contextWindowAriaLabel(state)}
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
          aria-label={contextWindowAriaLabel(state)}
          className={cn(
            "ml-2 inline-flex items-center gap-1 rounded-full text-token-description-foreground outline-none focus-visible:ring-2 focus-visible:ring-(--ring)",
            className,
          )}
        >
          {ring}
          {shouldShowFallbackLabel ? (
            <span className="composer-footer__label--sm select-none whitespace-nowrap text-sm text-token-input-placeholder-foreground opacity-60">
              {state.status === "usageOnly" ? formatRoundedTokenThousands(state.usedTokens) : "—"}
            </span>
          ) : null}
        </button>
      )}
    </NodexTooltip>
  );
}
