import { AnimatePresence, motion, type MotionValue, type Transition } from "motion/react";
import type { ReactNode } from "react";
import {
  ProjectSessionSidebar,
  type ProjectSessionSidebarProps,
} from "./workbench-session-sidebar";
import { cn } from "@/lib/utils";
import { WorkbenchSpaceSidebar } from "./workbench-space-sidebar";
import type { SidebarPagesSectionProps } from "./sidebar-pages-section";

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
  readonly header: ReactNode;
  readonly outerClassName: string;
  readonly resizing: boolean;
  readonly reducedMotion: boolean;
  readonly exitX: number;
  readonly transition: Transition;
  readonly onResizeActiveChange: (active: boolean) => void;
  readonly onHoverSurfaceOpenChange: (open: boolean) => void;
}

interface WorkbenchSidebarProps {
  readonly destination: "home" | "space";
  readonly body: WorkbenchSidebarBodyProps;
  readonly inline: WorkbenchInlineSidebarPlacement;
  readonly floating: WorkbenchFloatingSidebarPlacement;
}

/**
 * Owns the two chrome placements for one logical sidebar body. Placement can
 * change without duplicating the catalog/selection/command Interface.
 */
export function WorkbenchSidebar({ destination, body, inline, floating }: WorkbenchSidebarProps) {
  const renderSidebar = (
    placement: Pick<ProjectSessionSidebarProps, WorkbenchSidebarPlacementProp>,
  ) =>
    destination === "space" ? (
      <WorkbenchSpaceSidebar body={body} {...placement} />
    ) : (
      <ProjectSessionSidebar {...body} {...placement} />
    );

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
            data-sidebar-floating-focus-area="true"
            data-testid="floating-project-session-sidebar-shell"
            className={cn(floating.outerClassName, floating.resizing && "cursor-col-resize")}
            style={{ width: body.width }}
            initial={floating.reducedMotion ? false : { opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: floating.exitX }}
            transition={floating.transition}
          >
            {renderSidebar({
              floating: true,
              header: floating.header,
              onResizeActiveChange: floating.onResizeActiveChange,
              onHoverSurfaceOpenChange: floating.onHoverSurfaceOpenChange,
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
