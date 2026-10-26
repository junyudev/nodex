import { AnimatePresence, motion, type MotionValue } from "motion/react";
import {
  ProjectSessionSidebar,
  type ProjectSessionSidebarProps,
} from "./workbench-session-sidebar";
import { cn } from "@/lib/utils";
import { WorkbenchSpaceSidebar } from "./workbench-space-sidebar";
import {
  ScheduledSidebar,
  type ScheduledSidebarNavigation,
} from "@/features/scheduled/scheduled-sidebar";
import type { WorkbenchPrimaryDestination } from "../../../shared/workbench-layout";
import type { SidebarPagesSectionProps } from "./sidebar-pages-section";
import { WORKBENCH_SURFACE_GUTTER_PX } from "@/lib/workbench-shell-geometry";
import {
  CODEX_SIDEBAR_FLOATING_PANEL_EXIT_TRANSITION,
  CODEX_SIDEBAR_FLOATING_PANEL_TRANSITION,
} from "@/lib/codex-sidebar-auto-reveal";
import { WORKBENCH_SIDEBAR_PEEK_SURFACE_ATTRIBUTE } from "@/lib/workbench-sidebar-peek";

type WorkbenchSidebarPlacementProp =
  | "animatedWidth"
  | "contentOpacity"
  | "floating"
  | "header"
  | "onHoverSurfaceOpenChange"
  | "onResizeActiveChange"
  | "resizeDisabled";

export type WorkbenchSidebarBodyProps = Omit<
  ProjectSessionSidebarProps,
  WorkbenchSidebarPlacementProp
> & {
  readonly pagesSectionCollapsed: SidebarPagesSectionProps["collapsed"];
  readonly onTogglePagesSectionCollapsed: SidebarPagesSectionProps["onToggle"];
  readonly onOpenResourceTarget: SidebarPagesSectionProps["onOpenRoot"];
  readonly onOpenResourceTargetInProject?: SidebarPagesSectionProps["onOpenInProject"];
  readonly activeResourceTarget: SidebarPagesSectionProps["activeRoot"];
};

interface WorkbenchInlineSidebarPlacement {
  readonly visible: boolean;
  readonly animatedWidth: MotionValue<number>;
  readonly contentOpacity: MotionValue<number>;
  readonly resizeDisabled: boolean;
}

interface WorkbenchFloatingSidebarPlacement {
  readonly visible: boolean;
  readonly destination?: WorkbenchPrimaryDestination;
  readonly outerClassName: string;
  readonly resizing: boolean;
  readonly reducedMotion: boolean;
  readonly onResizeActiveChange: (active: boolean) => void;
  readonly onHoverSurfaceOpenChange: (open: boolean) => void;
}

interface WorkbenchSidebarProps {
  readonly destination: WorkbenchPrimaryDestination;
  readonly body: WorkbenchSidebarBodyProps;
  readonly scheduled: ScheduledSidebarNavigation;
  readonly inline: WorkbenchInlineSidebarPlacement;
  readonly floating: WorkbenchFloatingSidebarPlacement;
}

/**
 * Owns the two chrome placements for one logical sidebar body. Placement can
 * change without duplicating the catalog/selection/command Interface.
 */
export function WorkbenchSidebar({
  destination,
  body,
  scheduled,
  inline,
  floating,
}: WorkbenchSidebarProps) {
  const renderSidebar = (
    placement: Pick<ProjectSessionSidebarProps, WorkbenchSidebarPlacementProp>,
    sidebarDestination = destination,
  ) => {
    const placedBody = placement.floating
      ? { ...body, width: body.width - WORKBENCH_SURFACE_GUTTER_PX }
      : body;
    if (sidebarDestination === "space")
      return <WorkbenchSpaceSidebar body={placedBody} {...placement} />;
    if (sidebarDestination === "scheduled")
      return (
        <ScheduledSidebar
          navigation={scheduled}
          width={placedBody.width}
          getWindowZoom={placedBody.getWindowZoom}
          onResizeWidth={placedBody.onResizeWidth}
          {...placement}
        />
      );
    return <ProjectSessionSidebar {...placedBody} {...placement} />;
  };

  return (
    <>
      {inline.visible
        ? renderSidebar({
            animatedWidth: inline.animatedWidth,
            contentOpacity: inline.contentOpacity,
            resizeDisabled: inline.resizeDisabled,
          })
        : null}

      <AnimatePresence initial={false}>
        {floating.visible ? (
          <motion.div
            key="codex-floating-left-panel"
            {...{ [WORKBENCH_SIDEBAR_PEEK_SURFACE_ATTRIBUTE]: floating.destination ?? destination }}
            data-testid="floating-project-session-sidebar-shell"
            className={cn(floating.outerClassName, floating.resizing && "cursor-col-resize")}
            style={{ width: body.width - WORKBENCH_SURFACE_GUTTER_PX }}
            initial={floating.reducedMotion ? false : { opacity: 0, x: -6 }}
            animate={{
              opacity: 1,
              x: 0,
              transition: floating.reducedMotion
                ? { duration: 0 }
                : CODEX_SIDEBAR_FLOATING_PANEL_TRANSITION,
            }}
            exit={{
              opacity: 0,
              x: floating.reducedMotion ? 0 : -3,
              transition: floating.reducedMotion
                ? { duration: 0 }
                : CODEX_SIDEBAR_FLOATING_PANEL_EXIT_TRANSITION,
            }}
          >
            {renderSidebar(
              {
                floating: true,
                onResizeActiveChange: floating.onResizeActiveChange,
                onHoverSurfaceOpenChange: floating.onHoverSurfaceOpenChange,
              },
              floating.destination,
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
