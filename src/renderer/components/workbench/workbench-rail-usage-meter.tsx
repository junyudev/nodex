import { FormattedMessage, useIntl, type IntlShape } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
import { AgentInstanceIcon } from "@/components/shared/icons/provider-icons";
import { subscriptionMeter } from "../../../shared/subscription-usage";
import { NODEX_BUTTON_COLOR_CLASS } from "@/components/ui/button";
import { NodexHoverCard } from "@/components/ui/hover-card";
import {
  describeUsageMeter,
  describeUsageMeterLabel,
  describeUsageProvenance,
  formatRateLimitResetLabel,
  formatUsageCountdown,
  formatUsageBalance,
  formatUsageCredits,
  formatUsageMoment,
  formatUsagePlan,
  type UsageBalanceView,
  type UsageCredits,
  type UsageMeterView,
  type UsageProvider,
  type UsageReading,
  type UsageSeverity,
  type UsageWindowView,
} from "@/lib/usage-meter";
import { useClockAt } from "@/lib/use-clock-at";
import { cn } from "@/lib/utils";

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Held-back headroom sits between the track (0.16) and a dimmed reading's arc (0.4). */
const HELD_BACK_OPACITY = 0.38;

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

type UsageRingTrack = "solid" | "dotted" | "spent" | "credits" | "open";

const clampPercent = (percent: number) => Math.max(0, Math.min(100, percent));

/**
 * Dashes one stretch of the ring, from `from` to `to` percent clockwise from the top. A full ring
 * is a plain circle: a dash's round caps would overlap at the top.
 */
function ringSegment(from: number, to: number) {
  if (from <= 0 && to >= 100) return {};
  return {
    strokeDasharray: `${((RING_CIRCUMFERENCE * (to - from)) / 100).toFixed(3)} ${RING_CIRCUMFERENCE.toFixed(3)}`,
    strokeDashoffset: ((-RING_CIRCUMFERENCE * from) / 100).toFixed(3),
  };
}

const RING_TRACK_PAINT: Readonly<
  Record<Exclude<UsageRingTrack, "open">, { stroke: string; opacity: number }>
> = {
  solid: { stroke: "currentColor", opacity: 0.16 },
  dotted: { stroke: "currentColor", opacity: 0.4 },
  spent: { stroke: "var(--red-text)", opacity: 0.45 },
  credits: { stroke: "var(--yellow-text)", opacity: 0.45 },
};

/** The reading came from this computer's Agent, never from the account's other devices. */
function usageHostLabel(intl: IntlShape): string {
  const isMac =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
  return isMac
    ? intl.formatMessage({
        id: "workbench.workbenchRailUsageMeter.thisMac",
        defaultMessage: "this Mac",
      })
    : intl.formatMessage({
        id: "workbench.workbenchRailUsageMeter.thisComputer",
        defaultMessage: "this computer",
      });
}

/** The account's mark: its one Agent instance's when it has one, else its runtime's. */
function UsageProviderMark({
  provider,
  instanceId,
  className,
}: {
  readonly provider: UsageProvider;
  readonly instanceId?: string;
  readonly className?: string;
}) {
  const driver = subscriptionMeter(provider)?.driver ?? provider;
  return <AgentInstanceIcon binding={{ driver, instanceId }} className={className} />;
}

/**
 * The rail's usage glyph: the provider's mark inside one ring. A solid track with an arc is a
 * measured level, a dotted track is a level Nodex does not know, a red track is a window that
 * is used up, an amber track is a used-up window that credits are carrying the account past, and
 * an open track with a plus is an account not signed in yet. Only low levels take color; a healthy
 * meter stays as quiet as the rail around it.
 *
 * When a shorter window runs out before a longer one, the arc continues faintly to the longer
 * window's level: headroom the shorter window holds back until it resets. A used-up window then
 * paints only what it holds back, not the whole track.
 */
export function UsageRingGlyph({
  provider,
  instanceId,
  mark,
  track,
  arc,
  heldBack,
  alert = false,
  pulse = false,
}: {
  readonly provider: UsageProvider;
  /** The one Agent instance the account belongs to, whose mark the ring shows. */
  readonly instanceId?: string;
  /** Replaces the provider mark, as for Nodex's own credit ring. */
  readonly mark?: ReactNode;
  readonly track: UsageRingTrack;
  readonly arc?: {
    readonly percent: number;
    readonly severity: UsageSeverity;
    readonly faded: boolean;
  } | null;
  /** The longer window's level, which the arc's window holds back beyond its own. */
  readonly heldBack?: { readonly percent: number; readonly severity: UsageSeverity } | null;
  readonly alert?: boolean;
  readonly pulse?: boolean;
}) {
  const percent = arc ? clampPercent(arc.percent) : 0;
  const heldBackPercent = heldBack ? clampPercent(heldBack.percent) : 0;
  const heldBackSpan = heldBackPercent - percent;
  // A used-up window's tone covers what it blocks: the headroom it holds back, else the whole ring.
  const blockedPaint =
    heldBackSpan > 0 && (track === "spent" || track === "credits") ? RING_TRACK_PAINT[track] : null;
  const trackPaint = RING_TRACK_PAINT[track === "open" || blockedPaint ? "solid" : track];
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
            data-usage-ring-track={blockedPaint ? "solid" : track}
            cx="14"
            cy="14"
            r={RING_RADIUS}
            strokeWidth="2.25"
            strokeLinecap="round"
            stroke={trackPaint.stroke}
            strokeOpacity={trackPaint.opacity}
            strokeDasharray={track === "dotted" ? "0.01 3.75" : undefined}
          />
        )}
        {heldBack && heldBackSpan > 0 ? (
          <circle
            data-usage-ring-held-back={blockedPaint ? track : heldBack.severity}
            cx="14"
            cy="14"
            r={RING_RADIUS}
            strokeWidth="2.25"
            strokeLinecap="round"
            stroke={blockedPaint?.stroke ?? SEVERITY_TONE[heldBack.severity]}
            strokeOpacity={
              blockedPaint?.opacity ?? (arc?.faded ? HELD_BACK_OPACITY * 0.6 : HELD_BACK_OPACITY)
            }
            {...ringSegment(percent, heldBackPercent)}
            className="transition-[stroke-dasharray,stroke-dashoffset,stroke,stroke-opacity] duration-500 ease-out motion-reduce:transition-none"
          />
        ) : null}
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
            {...ringSegment(0, percent)}
            className="transition-[stroke-dasharray,stroke-dashoffset,stroke,stroke-opacity] duration-500 ease-out motion-reduce:transition-none"
          />
        ) : null}
      </svg>
      <span
        className={cn(
          "inline-flex [&>svg]:size-3",
          (track === "dotted" || arc?.faded) && "opacity-60",
        )}
      >
        {mark ?? (
          <UsageProviderMark provider={provider} instanceId={instanceId} className="fill-current" />
        )}
      </span>
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
  const { level } = view;
  return (
    <UsageRingGlyph
      provider={view.reading.provider}
      instanceId={view.reading.instanceId}
      track={
        view.status === "unread"
          ? "dotted"
          : view.creditsInUse
            ? "credits"
            : level?.severity === "exhausted"
              ? "spent"
              : "solid"
      }
      arc={
        level
          ? { percent: level.remainingPercent, severity: level.severity, faded: view.stale }
          : null
      }
      heldBack={
        view.heldBack
          ? { percent: view.heldBack.remainingPercent, severity: view.heldBack.severity }
          : null
      }
      alert={view.reading.readFailed}
    />
  );
}

/** A card row's heading: what it measures, a note beside it, and the level at its end. */
function UsageRowHeading({
  label,
  meta,
  children,
}: {
  readonly label: string;
  readonly meta: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs text-token-description-foreground">
      <span className="shrink-0 text-sm font-medium text-token-foreground">{label}</span>
      {meta ? <span className="min-w-0 truncate">{meta}</span> : null}
      <span className="ml-auto shrink-0 tabular-nums">{children}</span>
    </div>
  );
}

/** A level as a thin bar: full when nothing is spent, colored only once it runs low. */
function UsageLevelBar({
  label,
  valueText,
  remainingPercent,
  severity,
  faded,
}: {
  readonly label: string;
  readonly valueText: string;
  readonly remainingPercent: number;
  readonly severity: UsageSeverity;
  readonly faded: boolean;
}) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={remainingPercent}
      aria-valuetext={valueText}
      className={cn(
        "h-1 overflow-hidden rounded-full",
        severity === "exhausted" ? "bg-(--red-text)/20" : "bg-token-foreground/10",
      )}
    >
      {remainingPercent > 0 ? (
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${remainingPercent}%`,
            backgroundColor:
              severity === "normal" ? "var(--color-token-foreground)" : SEVERITY_TONE[severity],
            opacity: faded ? 0.4 : severity === "normal" ? 0.55 : 1,
          }}
        />
      ) : null}
    </div>
  );
}

function UsageWindowRow({
  window,
  holdingBack,
  faded,
  now,
}: {
  readonly window: UsageWindowView;
  /** This window runs out before a longer one, whose headroom returns when this one resets. */
  readonly holdingBack: boolean;
  readonly faded: boolean;
  readonly now: number;
}) {
  const intl = useIntl();
  const exhausted = window.state === "measured" && window.severity === "exhausted";
  const meta =
    window.state === "elapsed"
      ? window.resetsAt === null
        ? null
        : intl.formatMessage(
            { id: "workbench.workbenchRailUsageMeter.resetPast", defaultMessage: "Reset {when}" },
            { when: formatUsageMoment(window.resetsAt, now, intl.locale) },
          )
      : window.resetsAt === null
        ? null
        : exhausted || holdingBack
          ? intl.formatMessage(
              {
                id: "workbench.workbenchRailUsageMeter.resetFuture",
                defaultMessage: "Resets {when}",
              },
              { when: formatUsageCountdown(window.resetsAt, now) },
            )
          : intl.formatMessage(
              {
                id: "workbench.workbenchRailUsageMeter.resetFuture",
                defaultMessage: "Resets {when}",
              },
              { when: formatRateLimitResetLabel(window.resetsAt, now, intl.locale) },
            );
  return (
    <div
      data-usage-window={window.id}
      data-usage-window-state={window.state}
      className="flex flex-col gap-1.5"
    >
      <UsageRowHeading label={window.label} meta={meta}>
        {window.state === "elapsed" ? (
          intl.formatMessage({
            id: "workbench.workbenchRailUsageMeter.unread",
            defaultMessage: "Not read yet",
          })
        ) : exhausted ? (
          <span className="font-medium text-(--red-text)">
            {intl.formatMessage({
              id: "workbench.workbenchRailUsageMeter.limitReached",
              defaultMessage: "Limit reached",
            })}
          </span>
        ) : (
          <FormattedMessage
            id="workbench.workbenchRailUsageMeter.remainingPercent"
            defaultMessage="<amount>{percent}%</amount> left"
            values={{
              percent: window.remainingPercent,
              amount: (chunks) => (
                <span
                  className={cn(
                    "text-sm font-medium text-token-foreground",
                    SEVERITY_TEXT[window.severity],
                  )}
                >
                  {chunks}
                </span>
              ),
            }}
          />
        )}
      </UsageRowHeading>
      {window.state === "elapsed" ? (
        <div aria-hidden="true" className="h-1 rounded-full bg-token-foreground/5" />
      ) : (
        <UsageLevelBar
          label={intl.formatMessage(
            {
              id: "workbench.workbenchRailUsageMeter.windowUsageRemaining",
              defaultMessage: "{window} usage remaining",
            },
            { window: window.label },
          )}
          valueText={
            exhausted
              ? intl.formatMessage({
                  id: "workbench.workbenchRailUsageMeter.limitReached",
                  defaultMessage: "Limit reached",
                })
              : intl.formatMessage(
                  {
                    id: "workbench.workbenchRailUsageMeter.percentLeft",
                    defaultMessage: "{percent}% left",
                  },
                  { percent: window.remainingPercent },
                )
          }
          remainingPercent={window.remainingPercent}
          severity={window.severity}
          faded={faded}
        />
      )}
    </div>
  );
}

/** The balance has no bar: unlike a window, it has no full mark to measure against. */
function UsageCreditsRow({
  credits,
  inUse,
}: {
  readonly credits: UsageCredits;
  readonly inUse: boolean;
}) {
  const intl = useIntl();
  const balance = formatUsageCredits(credits);
  const renderBalance = (value: ReactNode) => (
    <span className="text-sm font-medium text-token-foreground">{value}</span>
  );
  return (
    <UsageRowHeading
      label={intl.formatMessage({
        id: "workbench.workbenchRailUsageMeter.credits",
        defaultMessage: "Credits",
      })}
      meta={
        inUse ? (
          <span className={SEVERITY_TEXT.low}>
            {intl.formatMessage({
              id: "workbench.workbenchRailUsageMeter.inUse",
              defaultMessage: "In use",
            })}
          </span>
        ) : null
      }
    >
      {credits === "unlimited" ? (
        renderBalance(balance)
      ) : (
        <FormattedMessage
          id="workbench.workbenchRailUsageMeter.remainingCredits"
          defaultMessage="<amount>{balance}</amount> left"
          values={{ balance, amount: renderBalance }}
        />
      )}
    </UsageRowHeading>
  );
}

/**
 * A prepaid money balance. Its bar measures what is left of the last top-up, since a balance has
 * no full mark of its own; until a top-up is known it shows the amount alone.
 */
function UsageBalanceRow({
  balance,
  faded,
}: {
  readonly balance: UsageBalanceView;
  readonly faded: boolean;
}) {
  const intl = useIntl();
  const amount = formatUsageBalance(balance, intl.locale);
  const usedUp = balance.severity === "exhausted";
  const sinceTopUp = intl.formatMessage({
    id: "workbench.workbenchRailUsageMeter.sinceLastTopUp",
    defaultMessage: "Since last top-up",
  });
  return (
    <div data-usage-balance={balance.currency} className="flex flex-col gap-1.5">
      <UsageRowHeading
        label={intl.formatMessage({
          id: "workbench.workbenchRailUsageMeter.balance",
          defaultMessage: "Balance",
        })}
        meta={balance.remainingPercent !== null && !usedUp ? sinceTopUp : null}
      >
        {usedUp ? (
          <span className="font-medium text-(--red-text)">
            {intl.formatMessage({
              id: "workbench.workbenchRailUsageMeter.balanceUsedUp",
              defaultMessage: "Used up",
            })}
          </span>
        ) : (
          <FormattedMessage
            id="workbench.workbenchRailUsageMeter.remainingBalance"
            defaultMessage="<amount>{balance}</amount> left"
            values={{
              balance: amount,
              amount: (chunks) => (
                <span
                  className={cn(
                    "text-sm font-medium text-token-foreground",
                    SEVERITY_TEXT[balance.severity],
                  )}
                >
                  {chunks}
                </span>
              ),
            }}
          />
        )}
      </UsageRowHeading>
      {balance.remainingPercent !== null || usedUp ? (
        <UsageLevelBar
          label={intl.formatMessage({
            id: "workbench.workbenchRailUsageMeter.balanceRemaining",
            defaultMessage: "Balance remaining since last top-up",
          })}
          valueText={intl.formatMessage(
            {
              id: "workbench.workbenchRailUsageMeter.balanceLeft",
              defaultMessage: "{balance} left",
            },
            { balance: amount },
          )}
          remainingPercent={usedUp ? 0 : (balance.remainingPercent ?? 100)}
          severity={balance.severity}
          faded={faded}
        />
      ) : null}
    </div>
  );
}

/** Says why there is nothing to draw, unless the provenance footer already says it. */
function emptyUsageMessage(view: UsageMeterView, intl: IntlShape): string | null {
  if (view.status === "unmetered")
    return intl.formatMessage({
      id: "workbench.workbenchRailUsageMeter.unmetered",
      defaultMessage: "Billed by usage; no subscription limits apply.",
    });
  const silent = view.status === "unread" && view.windows.length === 0 && !view.reading.readFailed;
  return silent
    ? intl.formatMessage(
        {
          id: "workbench.workbenchRailUsageMeter.noLimits",
          defaultMessage: "{provider} hasn't reported usage limits yet.",
        },
        { provider: view.reading.title },
      )
    : null;
}

/**
 * One account's usage card: who the limits belong to, every window with its level and reset, and
 * where and when the reading was taken.
 */
export function UsageMeterCard({
  view,
  now,
  hostLabel,
  action,
  children,
}: {
  readonly view: UsageMeterView;
  readonly now: number;
  readonly hostLabel?: string;
  /** A trailing header action, such as signing out of the account. */
  readonly action?: ReactNode;
  /** Provider-specific rows after the windows and credits, such as quota resets. */
  readonly children?: ReactNode;
}) {
  const intl = useIntl();
  const { reading } = view;
  const plan = formatUsagePlan(reading);
  const provenance =
    view.status === "unmetered"
      ? null
      : describeUsageProvenance(view, hostLabel ?? usageHostLabel(intl), now);
  const empty = emptyUsageMessage(view, intl);
  return (
    <div data-usage-card={reading.provider} className="flex w-76 flex-col">
      <div className="flex items-center gap-2.5 py-2.5 pr-2 pl-3">
        <UsageProviderMark
          provider={reading.provider}
          instanceId={reading.instanceId}
          className="size-4"
        />
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
      {view.windows.length > 0 || reading.credits !== null || view.balance || empty || children ? (
        <section
          aria-label={intl.formatMessage({
            id: "workbench.workbenchRailUsageMeter.usageRemaining",
            defaultMessage: "Usage remaining",
          })}
          className="flex flex-col gap-3 border-t border-token-border p-3"
        >
          {view.windows.map((window) => (
            <UsageWindowRow
              key={window.id}
              window={window}
              holdingBack={view.heldBack !== null && window.id === view.binding?.id}
              faded={view.stale}
              now={now}
            />
          ))}
          {reading.credits !== null ? (
            <UsageCreditsRow credits={reading.credits} inUse={view.creditsInUse} />
          ) : null}
          {view.balance ? <UsageBalanceRow balance={view.balance} faded={view.stale} /> : null}
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
  const intl = useIntl();
  const [now, setNow] = useState(Date.now);
  const view = describeUsageMeter(reading, now);
  // The view changes on its own only when a window resets or the reading ages out.
  useClockAt(view.nextChangeAt, setNow);
  return (
    <NodexHoverCard
      ariaLabel={intl.formatMessage(
        {
          id: "workbench.workbenchRailUsageMeter.usageDetails",
          defaultMessage: "{provider} usage details",
        },
        { provider: reading.title },
      )}
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
