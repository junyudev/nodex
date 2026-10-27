import { useEffect, useState, type ReactNode } from "react";
import { ClaudeIcon, OpenAIIcon } from "@/components/shared/icons/provider-icons";
import { NODEX_BUTTON_COLOR_CLASS } from "@/components/ui/button";
import { NodexHoverCard } from "@/components/ui/hover-card";
import {
  describeUsageMeter,
  describeUsageMeterLabel,
  describeUsageProvenance,
  formatRateLimitResetLabel,
  formatUsageCountdown,
  formatUsageMoment,
  formatUsagePlan,
  type UsageMeterView,
  type UsageProvider,
  type UsageReading,
  type UsageSeverity,
  type UsageWindowView,
} from "@/lib/usage-meter";
import { cn } from "@/lib/utils";

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * The open track: the ring with a 70° gap at the lower right, where a plus offers to sign in.
 * The SVG is turned a quarter left so arcs start at the top; 135° here is the lower right.
 */
const OPEN_GAP_CENTER = 135;
const OPEN_GAP_HALF = 35;
const ringPoint = (degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  return [14 + RING_RADIUS * Math.cos(radians), 14 + RING_RADIUS * Math.sin(radians)] as const;
};
const OPEN_TRACK_PATH = (() => {
  const [startX, startY] = ringPoint(OPEN_GAP_CENTER + OPEN_GAP_HALF);
  const [endX, endY] = ringPoint(OPEN_GAP_CENTER - OPEN_GAP_HALF);
  return `M ${startX.toFixed(3)} ${startY.toFixed(3)} A ${RING_RADIUS} ${RING_RADIUS} 0 1 1 ${endX.toFixed(3)} ${endY.toFixed(3)}`;
})();
const OPEN_PLUS_PATH = (() => {
  const [x, y] = ringPoint(OPEN_GAP_CENTER);
  const arm = 3.2;
  return `M ${(x - arm).toFixed(3)} ${y.toFixed(3)} H ${(x + arm).toFixed(3)} M ${x.toFixed(3)} ${(y - arm).toFixed(3)} V ${(y + arm).toFixed(3)}`;
})();
const MAX_TIMEOUT_MS = 2_147_483_647;

const SEVERITY_TONE: Readonly<Record<UsageSeverity, string>> = {
  normal: "currentColor",
  low: "var(--yellow-text)",
  critical: "var(--red-text)",
  exhausted: "var(--red-text)",
};

const SEVERITY_TEXT: Readonly<Record<UsageSeverity, string | undefined>> = {
  normal: undefined,
  low: "text-(--yellow-text)",
  critical: "text-(--red-text)",
  exhausted: "text-(--red-text)",
};

/** The reading came from this computer's Agent, never from the account's other devices. */
export const USAGE_HOST_LABEL =
  typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC")
    ? "this Mac"
    : "this computer";

function UsageProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProvider;
  readonly className?: string;
}) {
  return provider === "codex" ? (
    <OpenAIIcon className={className} />
  ) : (
    <ClaudeIcon className={className} />
  );
}

/**
 * The rail's usage glyph: the provider's mark inside one ring. A solid track with an arc is a
 * measured level, a dotted track is a level Nodex does not know, a red track is a window that
 * is used up, and an open track with a plus is an account not signed in yet. Only low levels
 * take color; a healthy meter stays as quiet as the rail around it.
 */
export function UsageRingGlyph({
  provider,
  track,
  arc,
  alert = false,
  pulse = false,
}: {
  readonly provider: UsageProvider;
  readonly track: "solid" | "dotted" | "spent" | "open";
  readonly arc?: {
    readonly percent: number;
    readonly severity: UsageSeverity;
    readonly faded: boolean;
  } | null;
  readonly alert?: boolean;
  readonly pulse?: boolean;
}) {
  const percent = arc ? Math.max(0, Math.min(100, arc.percent)) : 0;
  return (
    <span
      className={cn(
        "relative inline-flex size-6 shrink-0 items-center justify-center",
        pulse && "animate-pulse motion-reduce:animate-none",
      )}
    >
      <svg
        viewBox="0 0 28 28"
        className="absolute inset-0 size-full -rotate-90 overflow-visible"
        fill="none"
        aria-hidden="true"
      >
        {track === "open" ? (
          <>
            <path
              data-usage-ring-track={track}
              d={OPEN_TRACK_PATH}
              strokeWidth="2.25"
              strokeLinecap="round"
              stroke="currentColor"
              strokeOpacity={0.16}
            />
            <path d={OPEN_PLUS_PATH} strokeWidth="2" strokeLinecap="round" stroke="currentColor" />
          </>
        ) : (
          <circle
            data-usage-ring-track={track}
            cx="14"
            cy="14"
            r={RING_RADIUS}
            strokeWidth="2.25"
            strokeLinecap="round"
            stroke={track === "spent" ? "var(--red-text)" : "currentColor"}
            strokeOpacity={track === "spent" ? 0.45 : track === "dotted" ? 0.4 : 0.16}
            strokeDasharray={track === "dotted" ? "0.01 3.75" : undefined}
          />
        )}
        {arc && percent > 0 ? (
          <circle
            data-usage-ring-arc={arc.severity}
            cx="14"
            cy="14"
            r={RING_RADIUS}
            strokeWidth="2.25"
            strokeLinecap="round"
            stroke={SEVERITY_TONE[arc.severity]}
            strokeOpacity={arc.faded ? 0.4 : 1}
            strokeDasharray={RING_CIRCUMFERENCE.toFixed(3)}
            strokeDashoffset={(RING_CIRCUMFERENCE * (1 - percent / 100)).toFixed(3)}
            className="transition-[stroke-dashoffset,stroke,stroke-opacity] duration-500 ease-out motion-reduce:transition-none"
          />
        ) : null}
      </svg>
      <UsageProviderMark
        provider={provider}
        className={cn("size-3 fill-current", (track === "dotted" || arc?.faded) && "opacity-60")}
      />
      {alert ? (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-(--yellow-text)"
        />
      ) : null}
    </span>
  );
}

function UsageRing({ view }: { readonly view: UsageMeterView }) {
  const { binding } = view;
  return (
    <UsageRingGlyph
      provider={view.reading.provider}
      track={
        view.status === "unread" ? "dotted" : binding?.severity === "exhausted" ? "spent" : "solid"
      }
      arc={
        binding
          ? { percent: binding.remainingPercent, severity: binding.severity, faded: view.stale }
          : null
      }
      alert={view.reading.readFailed}
    />
  );
}

function UsageWindowRow({
  window,
  faded,
  now,
}: {
  readonly window: UsageWindowView;
  readonly faded: boolean;
  readonly now: number;
}) {
  const exhausted = window.state === "measured" && window.severity === "exhausted";
  const meta =
    window.state === "elapsed"
      ? window.resetsAt === null
        ? null
        : `Reset ${formatUsageMoment(window.resetsAt, now)}`
      : window.resetsAt === null
        ? null
        : exhausted
          ? `Resets ${formatUsageCountdown(window.resetsAt, now)}`
          : `Resets ${formatRateLimitResetLabel(window.resetsAt, now)}`;
  return (
    <div
      data-usage-window={window.id}
      data-usage-window-state={window.state}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-baseline gap-1.5 text-xs text-token-description-foreground">
        <span className="shrink-0 text-sm font-medium text-token-foreground">{window.label}</span>
        {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
        <span className="ml-auto shrink-0 tabular-nums">
          {window.state === "elapsed" ? (
            "Not read yet"
          ) : exhausted ? (
            <span className="font-medium text-(--red-text)">Limit reached</span>
          ) : (
            <>
              <span
                className={cn(
                  "text-sm font-medium text-token-foreground",
                  SEVERITY_TEXT[window.severity],
                )}
              >
                {window.remainingPercent}%
              </span>{" "}
              left
            </>
          )}
        </span>
      </div>
      {window.state === "elapsed" ? (
        <div aria-hidden="true" className="h-1 rounded-full bg-token-foreground/5" />
      ) : (
        <div
          role="meter"
          aria-label={`${window.label} usage remaining`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={window.remainingPercent}
          aria-valuetext={exhausted ? "Limit reached" : `${window.remainingPercent}% left`}
          className={cn(
            "h-1 overflow-hidden rounded-full",
            exhausted ? "bg-(--red-text)/20" : "bg-token-foreground/10",
          )}
        >
          {window.remainingPercent > 0 ? (
            <div
              className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
              style={{
                width: `${window.remainingPercent}%`,
                backgroundColor:
                  window.severity === "normal"
                    ? "var(--color-token-foreground)"
                    : SEVERITY_TONE[window.severity],
                opacity: faded ? 0.4 : window.severity === "normal" ? 0.55 : 1,
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Says why there is nothing to draw, unless the provenance footer already says it. */
function emptyUsageMessage(view: UsageMeterView): string | null {
  if (view.status === "unmetered") return "Billed by usage; no subscription limits apply.";
  const silent = view.status === "unread" && view.windows.length === 0 && !view.reading.readFailed;
  return silent ? `${view.reading.title} hasn't reported usage limits yet.` : null;
}

/**
 * One account's usage card: who the limits belong to, every window with its level and reset, and
 * where and when the reading was taken.
 */
export function UsageMeterCard({
  view,
  now,
  hostLabel = USAGE_HOST_LABEL,
  action,
  children,
}: {
  readonly view: UsageMeterView;
  readonly now: number;
  readonly hostLabel?: string;
  /** A trailing header action, such as signing out of the account. */
  readonly action?: ReactNode;
  /** Provider-specific rows after the windows, such as quota reset credits. */
  readonly children?: ReactNode;
}) {
  const { reading } = view;
  const plan = formatUsagePlan(reading);
  const provenance =
    view.status === "unmetered" ? null : describeUsageProvenance(view, hostLabel, now);
  const empty = emptyUsageMessage(view);
  return (
    <div data-usage-card={reading.provider} className="flex w-76 flex-col">
      <div className="flex items-center gap-2.5 py-2.5 pr-2 pl-3">
        <UsageProviderMark provider={reading.provider} className="size-4" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 text-sm font-medium text-token-foreground">
              {reading.title}
            </span>
            {plan ? (
              <span className="min-w-0 truncate text-xs text-token-description-foreground">
                {plan}
              </span>
            ) : null}
          </div>
          {reading.account ? (
            <div className="truncate text-xs text-token-description-foreground">
              {reading.account}
            </div>
          ) : null}
        </div>
        {action}
      </div>
      {view.windows.length > 0 || empty || children ? (
        <section
          aria-label="Usage remaining"
          className="flex flex-col gap-3 border-t border-token-border p-3"
        >
          {view.windows.map((window) => (
            <UsageWindowRow key={window.id} window={window} faded={view.stale} now={now} />
          ))}
          {empty ? <p className="m-0 text-xs text-token-text-secondary">{empty}</p> : null}
          {children}
        </section>
      ) : null}
      {provenance ? (
        <footer
          data-usage-provenance=""
          className="flex flex-col gap-0.5 border-t border-token-border px-3 py-2 text-xs text-token-description-foreground"
        >
          <span className={cn(reading.readFailed && "text-(--yellow-text)")}>
            {provenance.status}
          </span>
          {provenance.detail ? <span>{provenance.detail}</span> : null}
        </footer>
      ) : null}
    </div>
  );
}

/**
 * A rail usage meter for one account: the ring, and on hover or focus the account's usage card.
 * Opening the card reads nothing new unless the caller asks to (`onOpenChange`).
 */
export function RailUsageMeter({
  reading,
  action,
  children,
  onOpenChange,
  className,
}: {
  readonly reading: UsageReading;
  readonly action?: ReactNode;
  readonly children?: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
  readonly className?: string;
}) {
  const [now, setNow] = useState(Date.now);
  const view = describeUsageMeter(reading, now);
  // The view changes on its own only when a window resets or the reading ages out.
  useEffect(() => {
    if (view.nextChangeAt === null) return;
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(Math.max(view.nextChangeAt - Date.now(), 0) + 50, MAX_TIMEOUT_MS),
    );
    return () => window.clearTimeout(timeout);
  }, [view.nextChangeAt]);
  return (
    <NodexHoverCard
      ariaLabel={`${reading.title} usage details`}
      hoverCardContent={
        <UsageMeterCard view={view} now={now} action={action}>
          {children}
        </UsageMeterCard>
      }
      placement="right-end"
      onOpenChange={(open) => {
        if (open) setNow(Date.now());
        onOpenChange?.(open);
      }}
    >
      <button
        type="button"
        aria-label={describeUsageMeterLabel(view, now)}
        data-usage-meter={reading.provider}
        data-usage-status={view.status}
        data-usage-stale={view.stale ? "" : undefined}
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-lg outline-none",
          NODEX_BUTTON_COLOR_CLASS.ghostSecondary,
          "focus-visible:bg-(--sidebar-accent) focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35",
          className,
        )}
      >
        <UsageRing view={view} />
      </button>
    </NodexHoverCard>
  );
}
