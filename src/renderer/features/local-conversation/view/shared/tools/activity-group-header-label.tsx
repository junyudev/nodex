import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { WorkingActivityIcon } from "@/components/shared/icons";
import { cn } from "../../../../../lib/utils";
import {
  CodexShimmerProvider,
  CodexShimmerText,
  useCodexShimmerEnabled,
} from "../codex-shimmer-text";
import { ActivityIconSwap, type ActivityIconPair } from "./activity-icon-swap";
import styles from "./activity-live-label.module.css";

/**
 * `working` names the tool that is running; `between-tools` is a live gap with nothing new to
 * say; `settled` is the finished summary.
 */
export type ActivityHeaderKind = "settled" | "working" | "between-tools";

export interface ActivityHeaderModel {
  kind: ActivityHeaderKind;
  label: ReactNode;
  /** Identity of the wording: a new key hands the label over, an equal key updates it in place. */
  labelKey: string;
  /** `null` borrows the glyph already on screen, or the generic working glyph. */
  icons: ActivityIconPair | null;
  /** Identity of the glyph family; consecutive commands share one and keep their icon still. */
  iconKey: string;
  animateIcon: boolean;
}

interface DisplayedHeader {
  header: ActivityHeaderModel;
  /** The label being released while its successor is revealed. */
  outgoing: ReactNode;
  /** This label took over from the turn's thinking line and makes room for its glyph. */
  receivedOpening: boolean;
}

const WORKING_ICONS: ActivityIconPair = {
  original: <WorkingActivityIcon />,
  alternate: null,
};

/** The turn's thinking line, offered to the group that takes over from it. */
export interface ActivityOpeningLabel {
  label: ReactNode;
  onExit: () => void;
}

const ActivityOpeningLabelContext = createContext<ActivityOpeningLabel | null>(null);

export const ActivityOpeningLabelProvider = ActivityOpeningLabelContext.Provider;

export function useActivityOpeningLabel(): ActivityOpeningLabel | null {
  return useContext(ActivityOpeningLabelContext);
}

/** A group that opens on a gap waits this long before admitting it is merely working. */
export const ACTIVITY_HEADER_FIRST_GAP_DELAY_MS = 1_000;

/** The turn's thinking line, carried on in a group that opened before it had anything to say. */
const OPENING_LABEL_KEY = "opening";

function hasSameIdentity(displayed: ActivityHeaderModel, requested: ActivityHeaderModel): boolean {
  return (
    displayed.labelKey === requested.labelKey &&
    displayed.kind === requested.kind &&
    (requested.icons == null || displayed.iconKey === requested.iconKey)
  );
}

function SettledActivityLabel({
  children,
  interactive,
}: {
  children: ReactNode;
  interactive: boolean;
}) {
  return (
    <span
      className={cn(
        "block max-w-full min-w-0 flex-1 truncate [--agent-activity-summary-color:var(--color-text-tertiary)] text-(--agent-activity-summary-color) [&_*:not(button)]:!text-(--agent-activity-summary-color)",
        interactive &&
          "[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:[--agent-activity-summary-color:var(--color-text)]",
      )}
    >
      {children}
    </span>
  );
}

/**
 * The icon and label of a work group's header. A live label never cuts in mid-sweep: a change
 * waits for the current sweep to finish, then the new wording is uncovered left to right while
 * the old one fades. Between tools the last label holds; only a group that opens on a gap says
 * "Working", and only after a beat. The first tool takes over the turn's thinking line, sliding
 * in beside its glyph. Settling replaces everything at once.
 */
export function ActivityGroupHeaderLabel({
  header,
  interactive,
  onOpeningLabelExit,
  openingLabel,
}: {
  header: ActivityHeaderModel;
  interactive: boolean;
  /** Called once the turn's thinking line, handed over by `openingLabel`, has left. */
  onOpeningLabelExit?: () => void;
  /** The turn's thinking line, released as the first tool's label arrives. */
  openingLabel?: ReactNode;
}) {
  const shimmerEnabled = useCodexShimmerEnabled();
  const [sweeping, setSweeping] = useState(false);
  const [displayed, setDisplayed] = useState<DisplayedHeader | null>(null);
  const [firstGapElapsed, setFirstGapElapsed] = useState(false);
  const shown = displayed?.header ?? null;
  // A group that opens on a gap keeps saying what the thinking line said until a tool speaks.
  const requested: ActivityHeaderModel =
    header.kind === "between-tools" && shown == null && openingLabel != null && shimmerEnabled
      ? {
          kind: "working",
          label: openingLabel,
          labelKey: OPENING_LABEL_KEY,
          icons: { original: null, alternate: null },
          iconKey: "none",
          animateIcon: false,
        }
      : header;
  const isSettled = requested.kind === "settled";
  const isBetweenTools = requested.kind === "between-tools";
  const awaitingFirstGap = isBetweenTools && shown == null;

  useEffect(() => {
    if (!awaitingFirstGap) return;
    const timer = window.setTimeout(
      () => setFirstGapElapsed(true),
      ACTIVITY_HEADER_FIRST_GAP_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [awaitingFirstGap]);

  // A settled label has no sweep; a live label mounted later reports its own.
  if (isSettled && sweeping) setSweeping(false);
  const mayCommit =
    isSettled || (!sweeping && (!isBetweenTools || (awaitingFirstGap && firstGapElapsed)));
  const matches = shown != null && hasSameIdentity(shown, requested);
  if (mayCommit && !matches) {
    const carried =
      shown?.icons != null ? shown : { icons: WORKING_ICONS, iconKey: "working" as const };
    // The first tool with a glyph takes over the thinking line, once, when its label commits.
    const takesOverOpening =
      requested.kind === "working" &&
      shimmerEnabled &&
      openingLabel != null &&
      requested.icons?.original != null &&
      (shown == null || shown.labelKey === OPENING_LABEL_KEY);
    setDisplayed({
      header:
        isSettled || requested.icons != null
          ? requested
          : { ...requested, icons: carried.icons, iconKey: carried.iconKey },
      outgoing:
        isSettled ||
        shown == null ||
        shown.kind === "settled" ||
        shown.labelKey === requested.labelKey
          ? takesOverOpening && shown == null
            ? openingLabel
            : null
          : shown.label,
      receivedOpening: takesOverOpening,
    });
  }
  if (shown == null || displayed == null) return null;

  const label = matches ? requested.label : shown.label;
  const icons = matches && requested.icons != null ? requested.icons : shown.icons;
  const animateIcon = !isBetweenTools && (matches ? requested.animateIcon : shown.animateIcon);
  const makesRoom = displayed.receivedOpening && openingLabel != null;
  const outgoing = displayed.outgoing;
  const showOutgoing = sweeping && outgoing != null;
  const handleSweepChange = (nextSweeping: boolean) => {
    setSweeping(nextSweeping);
    if (nextSweeping) return;
    if (makesRoom) onOpeningLabelExit?.();
    setDisplayed((current) =>
      current?.outgoing != null ? { ...current, outgoing: null } : current,
    );
  };

  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2 overflow-hidden align-top">
      {icons && (icons.original != null || icons.alternate != null) ? (
        <ActivityIconSwap
          active={animateIcon}
          icons={icons}
          transitionKey={isSettled ? undefined : shown.iconKey}
          className={cn(
            "text-(--color-text-tertiary)",
            !isSettled && "icon-xs shrink-0",
            makesRoom && styles.receive,
          )}
        />
      ) : null}
      <span
        className={cn("grid min-w-0 flex-1 items-center truncate", makesRoom && styles.makeRoom)}
      >
        {isSettled ? (
          <SettledActivityLabel interactive={interactive}>{label}</SettledActivityLabel>
        ) : (
          <span role="status" data-shimmer-visibility-root="" className={styles.slot}>
            {showOutgoing ? (
              <span
                aria-hidden="true"
                inert
                className={cn("loading-shimmer-pure-text codex-cadenced-shimmer", styles.outgoing)}
              >
                <CodexShimmerProvider enabled={false}>{outgoing}</CodexShimmerProvider>
              </span>
            ) : null}
            <span className={cn(styles.viewport, showOutgoing && styles.reveal)}>
              <CodexShimmerText
                key={shown.labelKey}
                startWithSweep
                onSweepChange={handleSweepChange}
                className={cn("inline-block align-top", styles.label)}
              >
                <CodexShimmerProvider enabled={false}>{label}</CodexShimmerProvider>
              </CodexShimmerText>
            </span>
          </span>
        )}
      </span>
    </span>
  );
}
