import type { ReactNode, RefCallback } from "react";
import { cn } from "@/lib/utils";

/**
 * The rail and the docked sidebar share the window's chrome column, whose tint lies over the
 * frame's window fill; the content surface fills the rest of the window. With no sidebar beside
 * it, the surface takes in the rail's column too, so the titlebar row reads as one band across the
 * window and the rail sits on the surface without a seam.
 */
export function WorkbenchWorkspaceFrame({
  rail,
  railOnSurface = false,
  children,
  bodyRef,
  summaryLayout,
  widthClass,
}: {
  readonly rail: ReactNode;
  /** No sidebar is docked beside the content surface. */
  readonly railOnSurface?: boolean;
  readonly children: ReactNode;
  readonly bodyRef?: RefCallback<HTMLElement>;
  readonly summaryLayout?: string;
  readonly widthClass?: string;
}) {
  return (
    <div
      data-workbench-workspace-row
      className="relative flex min-h-0 min-w-0 flex-1 bg-(--app-shell-sidebar-background) pt-(--app-shell-workspace-top-inset)"
    >
      <div
        data-workbench-rail-column={railOnSurface ? "surface" : "chrome"}
        className={cn(
          "relative shrink-0",
          railOnSurface &&
            "-mt-(--app-shell-surface-lift) bg-(--color-surface) pt-(--app-shell-surface-lift)",
        )}
      >
        {rail}
      </div>
      <div
        ref={bodyRef}
        data-app-shell-summary-layout={summaryLayout}
        data-app-shell-width-class={widthClass}
        className="relative flex max-h-full min-h-0 min-w-0 flex-1"
      >
        {children}
      </div>
    </div>
  );
}
