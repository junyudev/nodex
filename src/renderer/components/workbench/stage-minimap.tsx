import { useCallback, useMemo } from "react";
import { FileText, LayoutGrid } from "lucide-react";
import { CardIcon } from "./card-icon";
import { ThreadsIcon } from "./threads-icon";
import {
  STAGE_ORDER,
  resolveExpandedStages,
  type StageId,
  type StageNavDirection,
} from "@/lib/use-workbench-state";
import type { StageRailLayoutMode } from "@/lib/stage-rail-layout-mode";
import { cn } from "@/lib/utils";

const STAGE_ICONS: Record<StageId, React.ComponentType<{ className?: string }>> = {
  db: LayoutGrid,
  cards: CardIcon,
  threads: ThreadsIcon,
  files: FileText,
};

const STAGE_LABELS: Record<StageId, string> = {
  db: "Database",
  cards: "Cards",
  threads: "Threads",
  files: "Files",
};

/** Size of each icon cell in px – matches titlebar button size (size-7 = 28px) */
const CELL_W = 28;
/** Gap between cells in px */
const GAP = 2;

interface StageMinimapProps {
  focusedStage: StageId;
  stageNavDirection: StageNavDirection;
  layoutMode: StageRailLayoutMode;
  slidingWindowPaneCount: number;
  onFocusStage: (stageId: StageId) => void;
}

export function StageMinimap({
  focusedStage,
  stageNavDirection,
  layoutMode,
  slidingWindowPaneCount,
  onFocusStage,
}: StageMinimapProps) {
  const expandedStages = useMemo(() => {
    if (layoutMode === "sliding-window") {
      return resolveExpandedStages(focusedStage, stageNavDirection, slidingWindowPaneCount, false);
    }
    // full-rail: only the focused stage is "visible"
    return [focusedStage];
  }, [focusedStage, layoutMode, slidingWindowPaneCount, stageNavDirection]);

  const expandedSet = useMemo(() => new Set(expandedStages), [expandedStages]);

  // Calculate sliding window position and width
  const windowStyle = useMemo(() => {
    if (expandedStages.length === 0) return { left: 0, width: 0 };

    const firstIdx = STAGE_ORDER.indexOf(expandedStages[0]);
    const lastIdx = STAGE_ORDER.indexOf(expandedStages[expandedStages.length - 1]);

    const left = firstIdx * (CELL_W + GAP);
    const span = lastIdx - firstIdx + 1;
    const width = span * CELL_W + (span - 1) * GAP;

    return { left, width };
  }, [expandedStages]);

  const handleClick = useCallback(
    (stageId: StageId) => {
      onFocusStage(stageId);
    },
    [onFocusStage],
  );

  const totalWidth = STAGE_ORDER.length * CELL_W + (STAGE_ORDER.length - 1) * GAP;

  return (
    <div
      className="relative flex items-center"
      style={{
        width: totalWidth,
        height: CELL_W,
      } as React.CSSProperties}
    >
      {/* Sliding window highlight */}
      <div
        className="absolute inset-y-0 rounded-md bg-(--foreground)/8 transition-all duration-300 ease-standard"
        style={{
          left: windowStyle.left,
          width: windowStyle.width,
        }}
      />

      {/* Stage icons */}
      {STAGE_ORDER.map((stageId, i) => {
        const Icon = STAGE_ICONS[stageId];
        const isExpanded = expandedSet.has(stageId);
        const isFocused = stageId === focusedStage;

        return (
          <button
            key={stageId}
            type="button"
            onClick={() => handleClick(stageId)}
            title={STAGE_LABELS[stageId]}
            aria-label={STAGE_LABELS[stageId]}
            className={cn(
              "relative z-10 inline-flex shrink-0 items-center justify-center rounded-sm transition-all duration-200",
              isFocused
                ? "text-(--foreground)"
                : isExpanded
                  ? "text-(--foreground)/70"
                  : "text-(--foreground)/25 hover:text-(--foreground)/50",
            )}
            style={{
              width: CELL_W,
              height: CELL_W,
              marginLeft: i > 0 ? GAP : 0,
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
