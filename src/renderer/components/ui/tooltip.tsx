import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useState,
  type ComponentPropsWithRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import {
  APP_SHELL_TOOLTIP_LAYER_CLASS,
  APP_SHELL_TOOLTIP_LAYER_INDEX,
} from "@/lib/app-shell-layers";
import { cn } from "@/lib/utils";
import {
  dismissNodexFloatingSurfaces,
  makeNodexFloatingSurfaceBoundaryStyle,
  NODEX_FLOATING_SURFACE_DISMISS_EVENT,
  nodexFloatingSurfaceBoundaryStyle,
  nodexFloatingSurfaceClassName,
  NodexFloatingSurfaceBody,
  useNodexFloatingSurfaceGlobalDismissal,
} from "./floating-surface";
import { NodexFloatingLayerProvider, useNodexFloatingLayerIndex } from "./floating-layer";
import { ShortcutKeycaps } from "./shortcut-keycaps";

export function dismissNodexTooltips() {
  dismissNodexFloatingSurfaces();
}

export type NodexTooltipProviderProps = TooltipPrimitive.Provider.Props;

const NodexTooltipProviderPresence = createContext(false);

export function NodexTooltipProvider({ children, delay = 0, ...props }: NodexTooltipProviderProps) {
  useNodexFloatingSurfaceGlobalDismissal();

  return (
    <NodexTooltipProviderPresence value>
      <TooltipPrimitive.Provider delay={delay} {...props}>
        {children}
      </TooltipPrimitive.Provider>
    </NodexTooltipProviderPresence>
  );
}

export interface NodexTooltipProps
  extends
    Omit<TooltipPrimitive.Popup.Props, "children" | "className" | "style">,
    Pick<
      TooltipPrimitive.Positioner.Props,
      | "align"
      | "alignOffset"
      | "side"
      | "sideOffset"
      | "collisionBoundary"
      | "collisionPadding"
      | "collisionAvoidance"
      | "positionMethod"
      | "sticky"
    > {
  children: ReactNode;
  tooltipContent: ReactNode;
  shortcutLabel?: string;
  disabled?: boolean;
  triggerRef?: RefObject<HTMLElement | null>;
  delay?: number;
  closeDelay?: number;
  delayOpen?: boolean;
  hoverable?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  surface?: "default" | "rich";
  tooltipClassName?: string;
  tooltipBodyClassName?: string;
  style?: CSSProperties;
}

export function NodexTooltip({
  children,
  tooltipContent,
  shortcutLabel,
  disabled = false,
  triggerRef,
  delay,
  closeDelay,
  delayOpen,
  hoverable = false,
  open,
  defaultOpen,
  onOpenChange,
  surface = "default",
  tooltipClassName,
  tooltipBodyClassName,
  align,
  alignOffset,
  side = "bottom",
  sideOffset = 2,
  collisionBoundary,
  collisionPadding = 8,
  collisionAvoidance,
  positionMethod,
  sticky,
  style,
  id: tooltipIdProp,
  ...props
}: NodexTooltipProps) {
  const hasSharedProvider = useContext(NodexTooltipProviderPresence);
  const isControlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const layerIndex = useNodexFloatingLayerIndex(style?.zIndex, APP_SHELL_TOOLTIP_LAYER_INDEX);
  const generatedTooltipId = useId();
  const tooltipId = tooltipIdProp ?? generatedTooltipId;

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleDismiss = () => {
      const isOpen = isControlled ? open : uncontrolledOpen;

      if (!isControlled) setUncontrolledOpen(false);
      if (isOpen) onOpenChange?.(false);
    };

    window.addEventListener(NODEX_FLOATING_SURFACE_DISMISS_EVENT, handleDismiss);
    return () => window.removeEventListener(NODEX_FLOATING_SURFACE_DISMISS_EVENT, handleDismiss);
  }, [isControlled, onOpenChange, open, uncontrolledOpen]);

  const tooltipDisabled = disabled || tooltipContent == null;
  if (!isValidElement(children)) {
    throw new Error("NodexTooltip requires one concrete interactive child");
  }

  const resolvedOpen = isControlled ? open : uncontrolledOpen;
  const resolvedDelay = delayOpen ? 250 : delay;
  const richSurface = surface === "rich";
  const shortcut = shortcutLabel ? (
    <ShortcutKeycaps keys={[shortcutLabel]} density="compact" />
  ) : null;
  const boundaryAliases = makeNodexFloatingSurfaceBoundaryStyle(
    "var(--available-width)",
    "var(--available-height)",
    "var(--anchor-width)",
    "var(--anchor-height)",
  );

  const tooltip = (
    <TooltipPrimitive.Root
      open={resolvedOpen}
      disabled={tooltipDisabled}
      onOpenChange={(nextOpen) => {
        if (!isControlled) setUncontrolledOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
      disableHoverablePopup={!hoverable}
    >
      <TooltipPrimitive.Trigger
        ref={triggerRef as ComponentPropsWithRef<typeof TooltipPrimitive.Trigger>["ref"]}
        render={children}
        delay={resolvedDelay}
        closeDelay={closeDelay}
        aria-describedby={!tooltipDisabled && resolvedOpen ? tooltipId : undefined}
      />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          data-slot="tooltip-positioner"
          align={align}
          alignOffset={alignOffset}
          side={side}
          sideOffset={sideOffset}
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          collisionAvoidance={collisionAvoidance}
          positionMethod={positionMethod}
          sticky={sticky}
          className={APP_SHELL_TOOLTIP_LAYER_CLASS}
          style={{ ...boundaryAliases, zIndex: layerIndex }}
        >
          <TooltipPrimitive.Popup
            data-slot="tooltip-content"
            className={cn(
              richSurface
                ? nodexFloatingSurfaceClassName
                : "no-drag w-fit select-none rounded-lg border-[0.5px] border-token-border bg-token-dropdown-background px-2 py-1 font-sans text-sm leading-4.5 text-token-foreground whitespace-normal break-words",
              !richSurface && APP_SHELL_TOOLTIP_LAYER_CLASS,
              tooltipClassName,
            )}
            style={{
              ...boundaryAliases,
              ...(richSurface
                ? nodexFloatingSurfaceBoundaryStyle
                : {
                    maxWidth:
                      "min(20rem, var(--nodex-floating-surface-available-width), calc(100vw - 16px))",
                    maxHeight:
                      "min(var(--nodex-floating-surface-available-height), calc(100vh - 16px))",
                  }),
              zIndex: layerIndex,
              ...style,
            }}
            id={tooltipId}
            role="tooltip"
            {...props}
          >
            <NodexFloatingLayerProvider zIndex={layerIndex}>
              {richSurface ? (
                <NodexFloatingSurfaceBody className={tooltipBodyClassName} shortcut={shortcut}>
                  {tooltipContent}
                </NodexFloatingSurfaceBody>
              ) : (
                <div className="flex items-center gap-2">
                  <div className={cn("min-w-0", tooltipBodyClassName)}>{tooltipContent}</div>
                  {shortcut ? <span>{shortcut}</span> : null}
                </div>
              )}
            </NodexFloatingLayerProvider>
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );

  if (hasSharedProvider) return tooltip;
  return <TooltipPrimitive.Provider delay={0}>{tooltip}</TooltipPrimitive.Provider>;
}
