/** Space kept between the leading and trailing sides of a single-row viewer header. */
export const VIEWER_HEADER_SIDE_GAP = 80;

export type ViewerHeaderSide = "leading" | "trailing";

/** One region inside a slot that may be hidden before the slot itself, lowest priority first. */
export interface ViewerHeaderCollapseStep {
  readonly priority: number;
  readonly selector: string;
}

export interface ViewerHeaderSlotLayout {
  readonly id: string;
  readonly allowShrink?: boolean;
  readonly grow?: boolean;
  readonly collapseSteps?: readonly ViewerHeaderCollapseStep[];
  /** Hides the slot's `[data-viewer-header-collapsible]` regions at this priority. */
  readonly collapsePriority?: number;
  /** Hides the whole slot at this priority; slots without one are never hidden. */
  readonly hidePriority?: number;
}

export interface ViewerHeaderPlannedStep<Slot> {
  readonly slot: Slot;
  readonly priority: number | undefined;
  /** Selectors to hide inside the slot, or `null` to hide the whole slot. */
  readonly selectors: readonly string[] | null;
}

/**
 * Orders every collapse step of every slot: inner regions and whole slots interleave by priority,
 * and steps without a priority sort last (they never run).
 */
export function planViewerHeaderCollapse<Slot extends ViewerHeaderSlotLayout>(
  slots: readonly Slot[],
): ViewerHeaderPlannedStep<Slot>[] {
  return slots
    .flatMap((slot) => {
      const steps: ViewerHeaderPlannedStep<Slot>[] = (slot.collapseSteps ?? []).map((step) => ({
        slot,
        priority: step.priority,
        selectors: [step.selector],
      }));
      if (slot.collapsePriority !== undefined) {
        steps.push({
          slot,
          priority: slot.collapsePriority,
          selectors: ["[data-viewer-header-collapsible]"],
        });
      }
      steps.push({ slot, priority: slot.hidePriority, selectors: null });
      return steps;
    })
    .toSorted(
      (left, right) =>
        (left.priority ?? Number.POSITIVE_INFINITY) - (right.priority ?? Number.POSITIVE_INFINITY),
    );
}

export interface ViewerHeaderSideMetrics {
  readonly width: number;
  readonly count: number;
  readonly gap: number;
}

/** Width the visible slots need on one row. */
export function viewerHeaderRequiredWidth(
  leading: ViewerHeaderSideMetrics,
  trailing: ViewerHeaderSideMetrics,
): number {
  const leadingWidth = leading.width + Math.max(0, leading.count - 1) * leading.gap;
  const trailingWidth = trailing.width + Math.max(0, trailing.count - 1) * trailing.gap;
  return (
    leadingWidth +
    trailingWidth +
    (leading.count > 0 && trailing.count > 0 ? VIEWER_HEADER_SIDE_GAP : 0)
  );
}
