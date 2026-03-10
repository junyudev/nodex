import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "../../../lib/utils";
import type { ContextWindowIndicatorState } from "@/lib/codex-context-window";

const PROMPT_TEXTAREA_MAX_VIEWPORT_RATIO = 0.25;
const FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX = 220;
const CONTEXT_RING_RADIUS = 5;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;
const COMPACT_TOKEN_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});
const WHOLE_TOKEN_FORMATTER = new Intl.NumberFormat("en-US");

export function resolvePromptTextareaMaxHeightPx(): number {
  if (typeof window === "undefined") return FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX;

  const maxHeightPx = Math.floor(window.innerHeight * PROMPT_TEXTAREA_MAX_VIEWPORT_RATIO);
  if (!Number.isFinite(maxHeightPx) || maxHeightPx <= 0) {
    return FALLBACK_PROMPT_TEXTAREA_MAX_HEIGHT_PX;
  }

  return maxHeightPx;
}

function formatCompactTokenCount(value: number): string {
  const normalizedValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return COMPACT_TOKEN_FORMATTER.format(normalizedValue).replace("K", "k");
}

function formatWholeTokenCount(value: number): string {
  const normalizedValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return WHOLE_TOKEN_FORMATTER.format(normalizedValue);
}

function renderContextWindowTooltip(state: ContextWindowIndicatorState) {
  if (state.status === "ready" && state.usedTokens !== null && state.windowTokens !== null) {
    return (
      <div className="flex max-w-52 flex-col items-center gap-1 text-center">
        <div className="text-xs text-(--foreground-tertiary)">Context window:</div>
        <div className="text-xl font-semibold text-(--foreground)">{state.percentFull}% full</div>
        <div className="text-lg font-semibold text-(--foreground)">
          {formatCompactTokenCount(state.usedTokens)} / {formatCompactTokenCount(state.windowTokens)} tokens used
        </div>
        <div className="text-sm text-(--foreground-secondary)">Codex automatically compacts its context</div>
      </div>
    );
  }

  if (state.status === "usageOnly" && state.usedTokens !== null) {
    return (
      <div className="flex max-w-44 flex-col items-center gap-1 text-center">
        <div className="text-xs text-(--foreground-tertiary)">Context window:</div>
        <div className="text-lg font-semibold text-(--foreground)">
          {formatCompactTokenCount(state.usedTokens)} tokens in context
        </div>
        <div className="text-sm text-(--foreground-secondary)">Model context window not reported yet</div>
      </div>
    );
  }

  return (
    <div className="flex max-w-44 flex-col items-center gap-1 text-center">
      <div className="text-xs text-(--foreground-tertiary)">Context window:</div>
      <div className="text-lg font-semibold text-(--foreground)">Waiting for data</div>
      <div className="text-sm text-(--foreground-secondary)">Codex reports usage after token updates arrive</div>
    </div>
  );
}

function contextWindowAriaLabel(state: ContextWindowIndicatorState): string {
  if (state.status === "ready" && state.usedTokens !== null && state.windowTokens !== null) {
    return `Context window ${state.percentFull}% full, ${formatWholeTokenCount(state.usedTokens)} of ${formatWholeTokenCount(state.windowTokens)} tokens used`;
  }

  if (state.status === "usageOnly" && state.usedTokens !== null) {
    return `Context window usage available, ${formatWholeTokenCount(state.usedTokens)} tokens in context`;
  }

  return "Context window data unavailable";
}

export function ContextWindowIndicator({ state }: { state: ContextWindowIndicatorState }) {
  const dashOffset = CONTEXT_RING_CIRCUMFERENCE * (1 - state.percentFull / 100);
  const toneClass =
    state.status !== "ready"
      ? "text-[var(--foreground-tertiary)]"
      : state.percentFull >= 90
        ? "text-[var(--destructive)]"
        : "text-[var(--foreground)]";

  return (
    <Tooltip
      content={renderContextWindowTooltip(state)}
      side="top"
      sideOffset={10}
      contentClassName="rounded-3xl px-4 py-3"
    >
      <button
        type="button"
        aria-label={contextWindowAriaLabel(state)}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-full transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-(--ring)",
          toneClass,
        )}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
          <circle cx="6" cy="6" r={CONTEXT_RING_RADIUS} stroke="currentColor" strokeWidth="2" fill="none" opacity="0.16" />
          <circle
            cx="6"
            cy="6"
            r={CONTEXT_RING_RADIUS}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
            strokeDasharray={CONTEXT_RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 6 6)"
            opacity={state.status === "unavailable" ? 0 : 1}
          />
        </svg>
      </button>
    </Tooltip>
  );
}

