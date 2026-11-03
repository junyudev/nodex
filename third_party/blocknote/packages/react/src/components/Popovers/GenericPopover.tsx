import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  useDismiss,
  useFloating,
  UseFloatingOptions,
  useHover,
  useInteractions,
  useMergeRefs,
  useTransitionStatus,
  useTransitionStyles,
} from "@floating-ui/react";
import {
  CSSProperties,
  HTMLAttributes,
  ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { useBlockNoteEditor } from "../../hooks/useBlockNoteEditor.js";
import { FloatingUIOptions } from "./FloatingUIOptions.js";

export type GenericPopoverReference =
  | {
      // A DOM element to use as the reference element for the popover.
      element: Element;
      // To update the popover position, `element.getReferenceBoundingRect`
      // is called. This flag caches the last result of the call while the
      // element is mounted to the DOM, so it doesn't update while the
      // popover is closing and transitioning out. Useful for if the
      // reference element unmounts, as `element.getReferenceBoundingRect`
      // would return a `DOMRect` with x, y, width, and height of 0.
      // Defaults to `true`.
      cacheMountedBoundingClientRect?: boolean;
    }
  | {
      element: undefined;
      // When no reference element is provided, this can be provided as an
      // alternative "virtual" element to position the popover around.
      getBoundingClientRect: () => DOMRect;
      // Optional per-line client rects, required by floating-ui's `inline()`
      // middleware. Virtual elements have no default `getClientRects`, so it
      // must be provided explicitly when `inline()` is used.
      getClientRects?: () => DOMRectList;
    }
  | {
      element: Element;
      cacheMountedBoundingClientRect?: boolean;
      // If both `element` and `getBoundingClientRect` are provided, uses
      // `getBoundingClientRect` to position the popover, but still treats
      // `element` as the reference element for all other purposes. When
      // `cacheMountedBoundingClientRect` is `true` or unspecified, this
      // function is not called while the reference element is not mounted.
      getBoundingClientRect: () => DOMRect;
      // See above.
      getClientRects?: () => DOMRectList;
    };

// Returns a modified version of `getBoundingClientRect`, if
// `reference.element` is passed and `reference.cacheMountedBoundingClientRect`
// is `true` or `undefined`. In the modified version, each new result is cached
// and returned while `reference.element` is connected to the DOM. If it is no
// longer connected, the cache is no longer updated and the last cached result
// is used.
//
// In all other cases, just returns `reference.getBoundingClientRect`, or
// `reference.element.getBoundingClientRect` if it's not defined.
export function getMountedBoundingClientRectCache(
  reference: GenericPopoverReference,
) {
  let lastBoundingClientRect = new DOMRect();
  const getBoundingClientRect =
    "getBoundingClientRect" in reference
      ? () => reference.getBoundingClientRect()
      : () => reference.element.getBoundingClientRect();

  return () => {
    if (
      reference.element &&
      (reference.cacheMountedBoundingClientRect ?? true)
    ) {
      if (reference.element.isConnected) {
        lastBoundingClientRect = getBoundingClientRect();
      }

      return lastBoundingClientRect;
    }

    return getBoundingClientRect();
  };
}

/**
 * Merges two `whileElementsMounted` handlers into one. Both run when elements
 * mount, and both cleanup functions are called on unmount.
 */
function mergeWhileElementsMounted(
  a: UseFloatingOptions["whileElementsMounted"],
  b: UseFloatingOptions["whileElementsMounted"],
): UseFloatingOptions["whileElementsMounted"] {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }

  return (reference, floating, update) => {
    const cleanupA = a(reference, floating, update);
    const cleanupB = b(reference, floating, update);
    return () => {
      cleanupA?.();
      cleanupB?.();
    };
  };
}

export const GenericPopover = (
  props: FloatingUIOptions & {
    reference?: GenericPopoverReference;
    children: ReactNode;
    /**
     * Override the DOM node this popover portals into. If omitted, falls back
     * to `editor.portalElement`.
     */
    portalElement?: HTMLElement | null;
  },
) => {
  const editor = useBlockNoteEditor();
  const portalRoot =
    props.portalElement === null
      ? typeof document !== "undefined"
        ? document.body
        : undefined
      : (props.portalElement ?? editor?.portalElement);
  if (!portalRoot) {
    throw new Error("Portal element not found");
  }
  const { refs, elements, floatingStyles, context } = useFloating<HTMLDivElement>({
    ...props.useFloatingOptions,
    whileElementsMounted: mergeWhileElementsMounted(
      autoUpdate,
      props.useFloatingOptions?.whileElementsMounted,
    ),
  });

  const { isMounted, styles } = useTransitionStyles(
    context,
    props.useTransitionStylesProps,
  );
  const { status } = useTransitionStatus(
    context,
    props.useTransitionStatusProps,
  );
  // Floating UI reports `status: open` for one render after a controlled owner
  // sets `open: false`. The owner state is authoritative for interactivity;
  // `isMounted` only keeps the same surface alive long enough to animate out.
  const isClosing = isMounted && (
    props.useFloatingOptions?.open === false || status === "close"
  );

  const dismiss = useDismiss(context, props.useDismissProps);
  const hover = useHover(context, { enabled: false, ...props.useHoverProps });
  // Also returns `getReferenceProps` but unused as the reference element may
  // not even be managed by React, so we may be unable to set them. Seems like
  // `refs.setReferences` attaches most of the same listeners anyway, but
  // possible both are needed.
  const { getFloatingProps } = useInteractions([dismiss, hover]);

  // Keep the final committed React subtree mounted during the exit transition
  // by default. Surfaces whose children derive from selection state can opt
  // into the static DOM snapshot below; the exit layer is inert, so it does
  // not need React-owned handlers during that visual-only interval.
  const lastOpenChildren = useRef<ReactNode>(props.children);
  const lastOpenInnerHTML = useRef("");
  const freezeChildrenOnClose = props.freezeChildrenOnClose === true;
  const hasRenderedChildren = props.children !== null
    && props.children !== undefined
    && props.children !== false;
  // A live position reference can become invalid in the same transaction that
  // closes a popover (for example, deleting its selected text). Exit motion is
  // visual state, so it must use the final rendered geometry rather than
  // recomputing against the mutated document.
  const lastOpenFloatingStyles = useRef<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const interactionRootCleanup = useRef<(() => void) | undefined>(undefined);
  const mergedRefs = useMergeRefs([ref, refs.setFloating]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || isClosing) {
      interactionRootCleanup.current?.();
      interactionRootCleanup.current = undefined;
      return undefined;
    }

    const unregister = editor.registerInteractionRoot(element);
    interactionRootCleanup.current = unregister;
    return () => {
      unregister();
      if (interactionRootCleanup.current === unregister) {
        interactionRootCleanup.current = undefined;
      }
    };
  }, [editor, isClosing, portalRoot]);

  if (isMounted && !isClosing) {
    lastOpenFloatingStyles.current = { ...floatingStyles };
  }

  const positionedStyles = isClosing
    ? lastOpenFloatingStyles.current
    : floatingStyles;

  useEffect(() => {
    if (props.reference) {
      const element =
        "element" in props.reference ? props.reference.element : undefined;

      if (
        element !== undefined &&
        (props.focusManagerProps?.disabled || !editor.isWithinEditor(element))
      ) {
        // Only set domReference when FloatingFocusManager is disabled.
        // When FloatingFocusManager is active (disabled !== false) and the
        // reference is inside the ProseMirror editor, setting domReference
        // causes floating-ui to call insertAdjacentElement on the reference,
        // inserting a focus-return <span> into the PM contenteditable. This
        // triggers PM's MutationObserver and resets the editor selection.
        // (issue #2525)
        refs.setReference(element);
      }

      // Forward `getClientRects` when provided, so floating-ui's `inline()`
      // middleware can read per-line rects off a virtual reference (it calls
      // `getClientRects()`, which virtual elements lack by default).
      const getClientRects =
        "getClientRects" in props.reference
          ? props.reference.getClientRects
          : undefined;

      refs.setPositionReference({
        getBoundingClientRect: getMountedBoundingClientRectCache(
          props.reference,
        ),
        ...(getClientRects ? { getClientRects } : {}),
        contextElement: element,
      });
    }
  }, [props.reference, refs, props.focusManagerProps?.disabled, editor]);

  // Layout effects run only for committed renders, so a close render observes the
  // final subtree that was actually visible rather than speculative work.
  useLayoutEffect(
    () => {
      if (isMounted && !isClosing && hasRenderedChildren) {
        lastOpenChildren.current = props.children;
      }
    },
    [
      hasRenderedChildren,
      isClosing,
      isMounted,
      props.children,
    ],
  );

  // Descendants can commit editor-state updates without changing the parent's
  // children identity. Capture the visible DOM, including those nested commits,
  // while open; never replace the snapshot with the closing subtree.
  useLayoutEffect(() => {
    const element = elements.floating;
    if (!element || !isMounted || isClosing || !freezeChildrenOnClose) {
      return;
    }
    const capture = () => {
      lastOpenInnerHTML.current = element.innerHTML;
    };
    capture();
    const observer = new MutationObserver(capture);
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    return () => observer.disconnect();
  }, [elements.floating, freezeChildrenOnClose, isClosing, isMounted]);

  if (!isMounted) {
    return false;
  }

  const mergedProps: HTMLAttributes<HTMLDivElement> = {
    ...props.elementProps,
    style: {
      display: "flex",
      ...props.elementProps?.style,
      zIndex: `calc(var(--bn-ui-base-z-index, 0) + ${props.elementProps?.style?.zIndex || 0})`,
      ...positionedStyles,
      ...styles,
    },
    ...getFloatingProps(),
  };
  const useFrozenChildren = isClosing
    && freezeChildrenOnClose
    && lastOpenInnerHTML.current.length > 0;

  const floatingElement = (
    <div
      ref={mergedRefs}
      {...mergedProps}
      {...(isClosing ? { inert: true, "aria-hidden": true } : {})}
      {...(useFrozenChildren
        ? { dangerouslySetInnerHTML: { __html: lastOpenInnerHTML.current } }
        : {})}
    >
      {useFrozenChildren ? null : isClosing ? lastOpenChildren.current : props.children}
    </div>
  );

  if (!props.focusManagerProps?.disabled) {
    return (
      <FloatingPortal root={portalRoot}>
        <FloatingFocusManager
          {...props.focusManagerProps}
          context={context}
          disabled={isClosing}
        >
          {floatingElement}
        </FloatingFocusManager>
      </FloatingPortal>
    );
  }

  return (
    <FloatingPortal root={portalRoot}>
      {floatingElement}
    </FloatingPortal>
  );
};
