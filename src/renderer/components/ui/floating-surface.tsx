import {
  forwardRef,
  useEffect,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { APP_SHELL_FLOATING_UI_LAYER_CLASS } from "@/lib/app-shell-layers";
import { cn } from "@/lib/utils";
import { NodexFloatingLayerProvider, useNodexFloatingLayerIndex } from "./floating-layer";

export const NODEX_FLOATING_SURFACE_DISMISS_EVENT = "codex:dismiss-tooltips";

export const NODEX_FLOATING_SURFACE_AVAILABLE_WIDTH = "--nodex-floating-surface-available-width";
export const NODEX_FLOATING_SURFACE_AVAILABLE_HEIGHT = "--nodex-floating-surface-available-height";
export const NODEX_FLOATING_SURFACE_ANCHOR_WIDTH = "--nodex-floating-surface-anchor-width";
export const NODEX_FLOATING_SURFACE_ANCHOR_HEIGHT = "--nodex-floating-surface-anchor-height";

const OPEN_FLOATING_ESCAPE_LAYER_SELECTOR = [
  '[data-slot="popover-content"][data-open]',
  '[data-slot="dropdown-content"][data-open]',
  '[data-slot="dropdown-submenu-content"][data-open]',
  '[data-slot="context-menu-content"][data-open]',
  '[data-slot="context-menu-subcontent"][data-open]',
  '[data-slot="hover-card-content"][data-state="open"]',
  '[data-slot="tooltip-content"][data-open]',
].join(",");

type FloatingSurfaceBoundaryStyle = CSSProperties & {
  [NODEX_FLOATING_SURFACE_AVAILABLE_WIDTH]?: string;
  [NODEX_FLOATING_SURFACE_AVAILABLE_HEIGHT]?: string;
  [NODEX_FLOATING_SURFACE_ANCHOR_WIDTH]?: string;
  [NODEX_FLOATING_SURFACE_ANCHOR_HEIGHT]?: string;
};

export function dismissNodexFloatingSurfaces(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NODEX_FLOATING_SURFACE_DISMISS_EVENT));
}

/**
 * Reports whether an accessible non-dialog floating layer currently owns Escape.
 *
 * Base UI normally stops Escape at the innermost popup. If its focused control
 * becomes disabled or disappears, however, the event starts at `document` and
 * independently registered Dialog and popup listeners can both dismiss. The
 * Keyboard owners defer through this shared boundary and let the event reach
 * the popup's own listener, including when a hover popup leaves focus elsewhere.
 * Hidden or inert background layers never claim the active dialog's Escape.
 */
export function hasOpenNodexFloatingEscapeLayer(ownerDocument: Document): boolean {
  return [...ownerDocument.querySelectorAll(OPEN_FLOATING_ESCAPE_LAYER_SELECTOR)].some(
    (layer) => !layer.closest('[hidden], [aria-hidden="true"], [inert], [data-base-ui-inert]'),
  );
}

let globalDismissalLeaseCount = 0;

function dismissNodexFloatingSurfacesOnHiddenDocument(): void {
  if (document.visibilityState !== "hidden") return;
  dismissNodexFloatingSurfaces();
}

/**
 * Gives a floating-surface provider a shared lease on the document lifecycle
 * listeners. Tooltip and HoverCard providers remain independently usable,
 * while nested app providers install only one listener set.
 */
export function useNodexFloatingSurfaceGlobalDismissal(): void {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (typeof document === "undefined") return undefined;

    globalDismissalLeaseCount += 1;
    if (globalDismissalLeaseCount === 1) {
      window.addEventListener("blur", dismissNodexFloatingSurfaces);
      window.addEventListener("pagehide", dismissNodexFloatingSurfaces);
      document.addEventListener("visibilitychange", dismissNodexFloatingSurfacesOnHiddenDocument);
    }

    return () => {
      globalDismissalLeaseCount -= 1;
      if (globalDismissalLeaseCount > 0) return;

      globalDismissalLeaseCount = 0;
      window.removeEventListener("blur", dismissNodexFloatingSurfaces);
      window.removeEventListener("pagehide", dismissNodexFloatingSurfaces);
      document.removeEventListener(
        "visibilitychange",
        dismissNodexFloatingSurfacesOnHiddenDocument,
      );
    };
  }, []);
}

export function makeNodexFloatingSurfaceBoundaryStyle(
  availableWidth: string,
  availableHeight: string,
  anchorWidth?: string,
  anchorHeight?: string,
): FloatingSurfaceBoundaryStyle {
  return {
    [NODEX_FLOATING_SURFACE_AVAILABLE_WIDTH]: availableWidth,
    [NODEX_FLOATING_SURFACE_AVAILABLE_HEIGHT]: availableHeight,
    [NODEX_FLOATING_SURFACE_ANCHOR_WIDTH]: anchorWidth,
    [NODEX_FLOATING_SURFACE_ANCHOR_HEIGHT]: anchorHeight,
  };
}

export const nodexFloatingSurfaceClassName = cn(
  "no-drag m-px flex w-fit select-none flex-col rounded-xl bg-token-dropdown-background/90 font-sans text-sm text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-sm whitespace-normal break-words",
  APP_SHELL_FLOATING_UI_LAYER_CLASS,
);

export const nodexFloatingSurfaceBoundaryStyle: FloatingSurfaceBoundaryStyle = {
  maxWidth:
    "min(20rem, var(--nodex-floating-surface-available-width, calc(100vw - 16px)), calc(100vw - 16px))",
  maxHeight:
    "min(var(--nodex-floating-surface-available-height, calc(100vh - 16px)), calc(100vh - 16px))",
};

export const NodexFloatingSurface = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function NodexFloatingSurface({ children, className, style, ...props }, ref) {
    const layerIndex = useNodexFloatingLayerIndex(style?.zIndex);

    return (
      <div
        ref={ref}
        className={cn(nodexFloatingSurfaceClassName, className)}
        style={{ ...nodexFloatingSurfaceBoundaryStyle, zIndex: layerIndex, ...style }}
        {...props}
      >
        <NodexFloatingLayerProvider zIndex={layerIndex}>{children}</NodexFloatingLayerProvider>
      </div>
    );
  },
);

export function NodexFloatingSurfaceBody({
  children,
  className,
  shortcut,
}: {
  children: ReactNode;
  className?: string;
  shortcut?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center gap-2">
      <div className={cn("flex min-h-0 min-w-0 w-full", className)}>{children}</div>
      {shortcut ? <span>{shortcut}</span> : null}
    </div>
  );
}
