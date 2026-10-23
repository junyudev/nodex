import {
  autoUpdate,
  flip,
  FloatingDelayGroup,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  safePolygon,
  shift,
  size,
  useDelayGroup,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useMergeRefs,
  useRole,
  type Delay,
  type OpenChangeReason,
  type Placement,
} from "@floating-ui/react";
import {
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLProps,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  NODEX_FLOATING_SURFACE_AVAILABLE_HEIGHT,
  NODEX_FLOATING_SURFACE_AVAILABLE_WIDTH,
  NODEX_FLOATING_SURFACE_DISMISS_EVENT,
  NodexFloatingSurface,
  NodexFloatingSurfaceBody,
  useNodexFloatingSurfaceGlobalDismissal,
} from "./floating-surface";

export const NODEX_HOVER_CARD_DELAY: Delay = {
  open: 700,
  close: 100,
};
export const NODEX_HOVER_CARD_HANDOFF_TIMEOUT_MS = 300;
export const NODEX_HOVER_CARD_SAFE_POLYGON_BUFFER = 8;

export interface NodexHoverCardProviderProps {
  children: ReactNode;
  delay?: Delay;
  timeoutMs?: number;
}

export function NodexHoverCardProvider({
  children,
  delay = NODEX_HOVER_CARD_DELAY,
  timeoutMs = NODEX_HOVER_CARD_HANDOFF_TIMEOUT_MS,
}: NodexHoverCardProviderProps) {
  useNodexFloatingSurfaceGlobalDismissal();

  return (
    <FloatingDelayGroup delay={delay} timeoutMs={timeoutMs}>
      {children}
    </FloatingDelayGroup>
  );
}

type HoverCardReferenceProps = HTMLProps<HTMLElement> & {
  ref?: Ref<HTMLElement>;
};

type HoverCardReferenceCloneProps = HoverCardReferenceProps & {
  "data-hover-card-state": "open" | "closed";
};

export interface NodexHoverCardProps {
  children: ReactElement;
  hoverCardContent: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  dismissOnReferencePress?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delay?: Delay;
  placement?: Placement;
  sideOffset?: number;
  collisionPadding?: number;
  contentClassName?: string;
  contentBodyClassName?: string;
  contentStyle?: CSSProperties;
}

export function NodexHoverCard({
  children,
  hoverCardContent,
  ariaLabel,
  disabled = false,
  dismissOnReferencePress = false,
  open,
  defaultOpen = false,
  onOpenChange,
  delay: localDelay,
  placement = "right-start",
  sideOffset = 2,
  collisionPadding = 8,
  contentClassName,
  contentBodyClassName,
  contentStyle,
}: NodexHoverCardProps) {
  const controlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const referenceElementRef = useRef<HTMLElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const requestedOpen = controlled ? open : uncontrolledOpen;
  const requestedOpenRef = useRef(requestedOpen);
  requestedOpenRef.current = requestedOpen;
  const resolvedOpen = !disabled && requestedOpen;

  const handleOpenChange = useCallback(
    (nextOpen: boolean, _event?: Event, reason?: OpenChangeReason): void => {
      if (disabled && nextOpen) return;
      if (requestedOpenRef.current === nextOpen) return;
      requestedOpenRef.current = nextOpen;

      if (!controlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChangeRef.current?.(nextOpen);

      if (nextOpen || reason !== "escape-key") return;

      queueMicrotask(() => {
        const reference = referenceElementRef.current;
        if (!reference) return;
        if (!reference.isConnected) return;

        const activeElement = reference.ownerDocument.activeElement;
        if (
          activeElement !== reference.ownerDocument.body &&
          activeElement?.isConnected !== false
        ) {
          return;
        }

        reference.focus({ preventScroll: true });
      });
    },
    [controlled, disabled],
  );

  useEffect(
    () => () => {
      if (!requestedOpenRef.current) return;
      requestedOpenRef.current = false;
      onOpenChangeRef.current?.(false);
    },
    [],
  );

  const {
    context,
    floatingStyles,
    placement: resolvedPlacement,
    refs,
  } = useFloating<HTMLElement>({
    open: resolvedOpen,
    onOpenChange: handleOpenChange,
    placement,
    middleware: [
      offset(sideOffset),
      flip({ padding: collisionPadding }),
      shift({ padding: collisionPadding }),
      size({
        padding: collisionPadding,
        apply({ availableHeight, availableWidth, elements }) {
          elements.floating.style.setProperty(
            NODEX_FLOATING_SURFACE_AVAILABLE_WIDTH,
            `${Math.max(0, availableWidth)}px`,
          );
          elements.floating.style.setProperty(
            NODEX_FLOATING_SURFACE_AVAILABLE_HEIGHT,
            `${Math.max(0, availableHeight)}px`,
          );
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const { delay: groupDelay } = useDelayGroup(context);
  const hover = useHover(context, {
    delay: localDelay ?? groupDelay,
    enabled: !disabled,
    // Activation cancels pending hover; require a fresh entry before showing it again.
    move: !dismissOnReferencePress,
    handleClose: safePolygon({
      buffer: NODEX_HOVER_CARD_SAFE_POLYGON_BUFFER,
    }),
  });
  const focus = useFocus(context, { enabled: !disabled });
  const dismiss = useDismiss(context, {
    enabled: !disabled,
    referencePress: dismissOnReferencePress,
  });
  const role = useRole(context, {
    enabled: !disabled,
    role: "dialog",
  });
  const contextMenuDismiss = disabled
    ? undefined
    : {
        reference: {
          onContextMenu(event: ReactMouseEvent<HTMLElement>) {
            handleOpenChange(false, event.nativeEvent);
          },
        },
      };
  const { getFloatingProps, getReferenceProps } = useInteractions([
    hover,
    focus,
    dismiss,
    role,
    contextMenuDismiss,
  ]);

  useEffect(() => {
    if (!disabled || !requestedOpen) return;
    handleOpenChange(false);
  }, [disabled, handleOpenChange, requestedOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handleGlobalDismiss = () => {
      if (!resolvedOpen) return;
      handleOpenChange(false);
    };

    window.addEventListener(NODEX_FLOATING_SURFACE_DISMISS_EVENT, handleGlobalDismiss);
    return () => {
      window.removeEventListener(NODEX_FLOATING_SURFACE_DISMISS_EVENT, handleGlobalDismiss);
    };
  }, [handleOpenChange, resolvedOpen]);

  const referenceChild = children as ReactElement<HoverCardReferenceProps>;
  const childProps = referenceChild.props;
  const mergedReferenceRef = useMergeRefs([refs.setReference, referenceElementRef, childProps.ref]);
  const referenceProps = getReferenceProps(childProps) as HoverCardReferenceProps;
  const referenceCloneProps = {
    ...referenceProps,
    "data-hover-card-state": resolvedOpen ? "open" : "closed",
    ref: mergedReferenceRef,
  } as HoverCardReferenceCloneProps;
  const reference = cloneElement(referenceChild, referenceCloneProps);

  return (
    <>
      {reference}
      {resolvedOpen ? (
        <FloatingPortal preserveTabOrder>
          <FloatingFocusManager
            context={context}
            initialFocus={-1}
            modal={false}
            returnFocus={false}
          >
            <NodexFloatingSurface
              ref={refs.setFloating}
              data-side={resolvedPlacement.split("-")[0]}
              data-slot="hover-card-content"
              data-state="open"
              {...getFloatingProps({
                "aria-label": ariaLabel,
                className: contentClassName,
                style: {
                  ...floatingStyles,
                  ...contentStyle,
                },
              })}
            >
              <NodexFloatingSurfaceBody className={contentBodyClassName}>
                {hoverCardContent}
              </NodexFloatingSurfaceBody>
            </NodexFloatingSurface>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  );
}
