import { mergeProps } from "@base-ui/react/merge-props";
import { handleMenuEditorKeyDown } from "./menu-keyboard";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import {
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

import { APP_SHELL_FLOATING_UI_LAYER_CLASS } from "@/lib/app-shell-layers";
import { cn } from "@/lib/utils";
import { NodexFloatingLayerProvider, useNodexFloatingLayerIndex } from "./floating-layer";
import { makeNodexFloatingSurfaceBoundaryStyle } from "./floating-surface";
import { handleNodexMenuItemClick, type NodexMenuSelectHandler } from "./menu-selection";
import { nodexMenuSurfaceClassName } from "./menu-surface";

const CONTEXT_MENU_BOUNDARY_STYLE: CSSProperties = {
  ...makeNodexFloatingSurfaceBoundaryStyle(
    "var(--available-width)",
    "var(--available-height)",
    "var(--anchor-width)",
    "var(--anchor-height)",
  ),
  maxWidth: "min(var(--nodex-floating-surface-available-width), calc(100vw - 16px))",
  maxHeight: "min(var(--nodex-floating-surface-available-height), calc(100vh - 16px))",
};

const CONTEXT_SUBMENU_MOTION_CLASS_NAME = "data-closed:invisible data-closed:pointer-events-none";

const CONTEXT_MENU_ITEM_CLASS_NAME = cn(
  "no-drag group flex w-full items-center gap-1.5 rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden",
  "cursor-interaction text-token-foreground data-highlighted:bg-token-list-hover-background focus:bg-token-list-hover-background",
  "data-[disabled]:pointer-events-none data-[disabled]:cursor-default data-[disabled]:opacity-50",
);

interface ContextMenuSubmenuRegistration {
  readonly id: symbol;
  readonly close: () => void;
}

interface ContextMenuSubmenuCoordinator {
  activate(registration: ContextMenuSubmenuRegistration): void;
  deactivate(id: symbol): void;
  dismissActive(): void;
}

const createContextMenuSubmenuCoordinator = (): ContextMenuSubmenuCoordinator => {
  let active: ContextMenuSubmenuRegistration | null = null;
  return {
    activate(registration) {
      if (active?.id === registration.id) return;
      const previous = active;
      active = registration;
      previous?.close();
    },
    deactivate(id) {
      if (active?.id === id) active = null;
    },
    dismissActive() {
      const previous = active;
      active = null;
      previous?.close();
    },
  };
};

const ContextMenuSubmenuCoordinatorContext = createContext<ContextMenuSubmenuCoordinator | null>(
  null,
);

function ContextMenuSubmenuCoordinatorProvider({ children }: { readonly children: ReactNode }) {
  const coordinatorRef = useRef<ContextMenuSubmenuCoordinator>(null);
  if (!coordinatorRef.current) coordinatorRef.current = createContextMenuSubmenuCoordinator();
  return (
    <ContextMenuSubmenuCoordinatorContext.Provider value={coordinatorRef.current}>
      {children}
    </ContextMenuSubmenuCoordinatorContext.Provider>
  );
}

export interface NodexContextMenuRootProps {
  readonly children?: ReactNode;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly disabled?: boolean;
  readonly loopFocus?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function NodexContextMenuRoot({ onOpenChange, ...props }: NodexContextMenuRootProps) {
  return (
    <ContextMenuPrimitive.Root
      {...props}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
    />
  );
}

export interface NodexContextMenuTriggerProps {
  readonly children: ReactElement;
  readonly className?: string;
  readonly disabled?: boolean;
}

export const NodexContextMenuTrigger = forwardRef<HTMLDivElement, NodexContextMenuTriggerProps>(
  function NodexContextMenuTrigger({ children, ...props }, ref) {
    if (!isValidElement(children)) {
      throw new Error("NodexContextMenuTrigger requires one concrete child");
    }
    return (
      <ContextMenuPrimitive.Trigger
        ref={ref}
        data-slot="context-menu-trigger"
        render={children}
        {...props}
      />
    );
  },
);

export interface NodexContextMenuPortalProps {
  readonly children?: ReactNode;
  readonly container?: HTMLElement | ShadowRoot | RefObject<HTMLElement | ShadowRoot | null> | null;
  readonly keepMounted?: boolean;
}

export function NodexContextMenuPortal(props: NodexContextMenuPortalProps) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}

function NodexContextMenuRowContent({
  children,
  leftSlot,
  rightSlot,
  tone = "default",
}: {
  readonly children: ReactNode;
  readonly leftSlot?: ReactNode;
  readonly rightSlot?: ReactNode;
  readonly tone?: "default" | "danger";
}) {
  return (
    <>
      {leftSlot ? (
        <span
          className={cn(
            "shrink-0 [&_svg]:size-4 [&_svg]:shrink-0",
            tone === "danger"
              ? "text-token-error-foreground"
              : "text-token-text-secondary group-data-[highlighted]:text-token-foreground group-focus:text-token-foreground",
          )}
        >
          {leftSlot}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {rightSlot ? (
        <span className="ml-2 shrink-0 text-token-description-foreground">{rightSlot}</span>
      ) : null}
    </>
  );
}

export interface NodexContextMenuItemProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "onSelect"
> {
  readonly disabled?: boolean;
  readonly closeOnClick?: boolean;
  readonly onSelect?: NodexMenuSelectHandler;
  readonly leftSlot?: ReactNode;
  readonly rightSlot?: ReactNode;
  readonly tone?: "default" | "danger";
}

export const NodexContextMenuItem = forwardRef<HTMLDivElement, NodexContextMenuItemProps>(
  function NodexContextMenuItem(
    {
      children,
      className,
      leftSlot,
      rightSlot,
      tone = "default",
      disabled = false,
      onClick,
      onSelect,
      onPointerEnter,
      onPointerMove,
      ...props
    },
    ref,
  ) {
    const coordinator = useContext(ContextMenuSubmenuCoordinatorContext);
    const handlePointerEnter: PointerEventHandler<HTMLDivElement> = (event) => {
      onPointerEnter?.(event);
      if (event.defaultPrevented || event.pointerType === "touch" || !coordinator) return;
      coordinator.dismissActive();
    };
    const handlePointerMove: PointerEventHandler<HTMLDivElement> = (event) => {
      onPointerMove?.(event);
      if (event.defaultPrevented || event.pointerType === "touch" || !coordinator) return;
      coordinator.dismissActive();
    };

    return (
      <ContextMenuPrimitive.Item
        ref={ref}
        disabled={disabled}
        onClick={
          disabled ? undefined : (event) => handleNodexMenuItemClick(event, onClick, onSelect)
        }
        className={cn(
          CONTEXT_MENU_ITEM_CLASS_NAME,
          tone === "danger" && "text-token-error-foreground",
          className,
        )}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        {...props}
      >
        <NodexContextMenuRowContent leftSlot={leftSlot} rightSlot={rightSlot} tone={tone}>
          {children}
        </NodexContextMenuRowContent>
      </ContextMenuPrimitive.Item>
    );
  },
);

export interface NodexContextMenuSubmenuTriggerProps extends ComponentPropsWithoutRef<"div"> {
  readonly leftSlot?: ReactNode;
  readonly rightSlot?: ReactNode;
}

/** A styled, concrete row composed by `NodexContextMenuSubmenu`. */
export const NodexContextMenuSubmenuTrigger = forwardRef<
  HTMLDivElement,
  NodexContextMenuSubmenuTriggerProps
>(function NodexContextMenuSubmenuTrigger(
  { children, className, leftSlot, rightSlot, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn(CONTEXT_MENU_ITEM_CLASS_NAME, className)} {...props}>
      <NodexContextMenuRowContent leftSlot={leftSlot} rightSlot={rightSlot}>
        {children}
      </NodexContextMenuRowContent>
    </div>
  );
});

export interface NodexContextMenuSubmenuProps {
  readonly disabled?: boolean;
  readonly trigger: ReactElement;
  readonly renderContent: () => ReactNode;
  readonly contentClassName?: string;
  readonly alignOffset?: number;
  readonly onContentFocusOutside?: (event: Event) => void;
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * Owns the complete submenu interaction contract. Content is not evaluated
 * until this submenu opens, and sibling coordination never updates a feature
 * menu's root state.
 */
export function NodexContextMenuSubmenu({
  disabled = false,
  trigger,
  renderContent,
  contentClassName,
  alignOffset,
  onContentFocusOutside,
  onOpenChange,
}: NodexContextMenuSubmenuProps) {
  const coordinator = useContext(ContextMenuSubmenuCoordinatorContext);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const idRef = useRef(Symbol("nodex-context-submenu"));
  const onOpenChangeRef = useRef(onOpenChange);
  useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  const registrationRef = useRef<ContextMenuSubmenuRegistration>(null);
  if (!registrationRef.current) {
    registrationRef.current = {
      id: idRef.current,
      close: () => {
        openRef.current = false;
        setOpen(false);
        onOpenChangeRef.current?.(false);
      },
    };
  }

  useEffect(() => () => coordinator?.deactivate(idRef.current), [coordinator]);

  const commitOpen = (nextOpen: boolean): void => {
    if (openRef.current === nextOpen) return;
    openRef.current = nextOpen;
    if (nextOpen) {
      coordinator?.activate(registrationRef.current!);
    } else {
      coordinator?.deactivate(idRef.current);
    }
    setOpen(nextOpen);
    onOpenChangeRef.current?.(nextOpen);
  };

  const handleOpenChange = (
    nextOpen: boolean,
    details: { readonly reason: string; readonly event: Event; cancel(): void },
  ): void => {
    if (!nextOpen && details.reason === "focus-out" && onContentFocusOutside) {
      onContentFocusOutside(details.event);
      if (details.event.defaultPrevented) {
        details.cancel();
        return;
      }
    }
    commitOpen(nextOpen);
  };

  const handlePointerActivation: PointerEventHandler<HTMLDivElement> = (event) => {
    if (event.defaultPrevented || event.pointerType === "touch" || disabled) return;
    commitOpen(true);
  };

  return (
    <ContextMenuPrimitive.SubmenuRoot open={open} onOpenChange={handleOpenChange}>
      <ContextMenuPrimitive.SubmenuTrigger
        render={trigger}
        disabled={disabled}
        data-nodex-context-menu-subtrigger="true"
        onPointerEnter={handlePointerActivation}
        onPointerMove={handlePointerActivation}
      />
      <ContextMenuPrimitive.Portal>
        <NodexContextMenuSubContent alignOffset={alignOffset} className={contentClassName}>
          {open ? renderContent() : null}
        </NodexContextMenuSubContent>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.SubmenuRoot>
  );
}

export interface NodexContextMenuContentProps extends ComponentPropsWithoutRef<"div"> {
  readonly align?: "start" | "center" | "end";
  readonly alignOffset?: number;
  readonly sideOffset?: number;
  readonly collisionPadding?: number;
  readonly finalFocus?:
    | boolean
    | RefObject<HTMLElement | null>
    | (() => boolean | HTMLElement | null | void);
}

export const NodexContextMenuContent = forwardRef<HTMLDivElement, NodexContextMenuContentProps>(
  function NodexContextMenuContent(
    {
      children,
      className,
      style,
      align,
      alignOffset,
      sideOffset,
      collisionPadding = 8,
      finalFocus,
      ...props
    },
    ref,
  ) {
    const layerIndex = useNodexFloatingLayerIndex(style?.zIndex);

    return (
      <ContextMenuPrimitive.Positioner
        data-slot="context-menu-positioner"
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={APP_SHELL_FLOATING_UI_LAYER_CLASS}
        style={{ zIndex: layerIndex }}
      >
        <ContextMenuPrimitive.Popup
          ref={ref}
          finalFocus={finalFocus}
          data-slot="context-menu-content"
          className={cn(nodexMenuSurfaceClassName, className)}
          style={{ ...CONTEXT_MENU_BOUNDARY_STYLE, zIndex: layerIndex, ...style }}
          {...mergeProps({ onKeyDown: handleMenuEditorKeyDown }, props)}
          data-nodex-keyboard-scope="local"
        >
          <NodexFloatingLayerProvider zIndex={layerIndex}>
            <ContextMenuSubmenuCoordinatorProvider>
              {children}
            </ContextMenuSubmenuCoordinatorProvider>
          </NodexFloatingLayerProvider>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    );
  },
);

export interface NodexContextMenuSubContentProps extends ComponentPropsWithoutRef<"div"> {
  readonly align?: "start" | "center" | "end";
  readonly alignOffset?: number;
  readonly sideOffset?: number;
  readonly collisionPadding?: number;
}

export const NodexContextMenuSubContent = forwardRef<
  HTMLDivElement,
  NodexContextMenuSubContentProps
>(function NodexContextMenuSubContent(
  {
    children,
    className,
    style,
    align,
    alignOffset,
    sideOffset = 0,
    collisionPadding = 8,
    ...props
  },
  ref,
) {
  const layerIndex = useNodexFloatingLayerIndex(style?.zIndex);

  return (
    <ContextMenuPrimitive.Positioner
      data-slot="context-menu-subpositioner"
      align={align}
      alignOffset={alignOffset}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={APP_SHELL_FLOATING_UI_LAYER_CLASS}
      style={{ zIndex: layerIndex }}
    >
      <ContextMenuPrimitive.Popup
        ref={ref}
        data-slot="context-menu-subcontent"
        className={cn(nodexMenuSurfaceClassName, CONTEXT_SUBMENU_MOTION_CLASS_NAME, className)}
        style={{ ...CONTEXT_MENU_BOUNDARY_STYLE, zIndex: layerIndex, ...style }}
        {...mergeProps({ onKeyDown: handleMenuEditorKeyDown }, props)}
        data-nodex-keyboard-scope="local"
      >
        <NodexFloatingLayerProvider zIndex={layerIndex}>
          <ContextMenuSubmenuCoordinatorProvider>{children}</ContextMenuSubmenuCoordinatorProvider>
        </NodexFloatingLayerProvider>
      </ContextMenuPrimitive.Popup>
    </ContextMenuPrimitive.Positioner>
  );
});
