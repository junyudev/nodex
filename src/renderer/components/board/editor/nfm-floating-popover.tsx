import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  useDismiss,
  useFloating,
  useHover,
  useInteractions,
  useMergeRefs,
  useTransitionStatus,
  useTransitionStyles,
} from "@floating-ui/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import type { FloatingUIOptions } from "@blocknote/react";

export type NfmPopoverReference =
  | {
      element: Element;
      cacheMountedBoundingClientRect?: boolean;
    }
  | {
      element: undefined;
      getBoundingClientRect: () => DOMRect;
    }
  | {
      element: Element;
      cacheMountedBoundingClientRect?: boolean;
      getBoundingClientRect: () => DOMRect;
    };

export function getMountedBoundingClientRectCache(reference: NfmPopoverReference) {
  let lastBoundingClientRect = new DOMRect();
  const getBoundingClientRect =
    "getBoundingClientRect" in reference
      ? () => reference.getBoundingClientRect()
      : () => reference.element.getBoundingClientRect();

  return () => {
    if (reference.element && (reference.cacheMountedBoundingClientRect ?? true)) {
      if (reference.element.isConnected) {
        lastBoundingClientRect = getBoundingClientRect();
      }

      return lastBoundingClientRect;
    }

    return getBoundingClientRect();
  };
}

export function NfmFloatingPopover(
  props: FloatingUIOptions & {
    reference?: NfmPopoverReference;
    portalElement?: HTMLElement | null;
    floatingRef?: Ref<HTMLDivElement>;
    children: ReactNode;
  },
) {
  const { refs, floatingStyles, context } = useFloating<HTMLDivElement>({
    whileElementsMounted: autoUpdate,
    ...props.useFloatingOptions,
  });
  const { isMounted, styles } = useTransitionStyles(context, props.useTransitionStylesProps);
  const { status } = useTransitionStatus(context, props.useTransitionStatusProps);
  const dismiss = useDismiss(context, props.useDismissProps);
  const hover = useHover(context, { enabled: false, ...props.useHoverProps });
  const { getFloatingProps } = useInteractions([dismiss, hover]);
  const [innerHTML, setInnerHTML] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const mergedRefs = useMergeRefs([ref, refs.setFloating, props.floatingRef]);

  useEffect(() => {
    if (!props.reference) return;

    const element = "element" in props.reference ? props.reference.element : undefined;

    if (element !== undefined) {
      refs.setReference(element);
    }

    refs.setPositionReference({
      getBoundingClientRect: getMountedBoundingClientRectCache(props.reference),
      contextElement: element,
    });
  }, [props.reference, refs]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || (status !== "initial" && status !== "open")) return;
    const capture = () => {
      if (node.innerHTML) setInnerHTML(node.innerHTML);
    };
    capture();
    const observer = new MutationObserver(capture);
    observer.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [status]);

  if (!isMounted) {
    return false;
  }

  const mergedProps: HTMLAttributes<HTMLDivElement> = {
    ...props.elementProps,
    style: {
      display: "flex",
      ...props.elementProps?.style,
      zIndex: `calc(var(--bn-ui-base-z-index, 0) + ${props.elementProps?.style?.zIndex ?? 0})`,
      ...floatingStyles,
      ...styles,
    },
    ...getFloatingProps(),
  };

  const renderWithPortal = (node: ReactNode) => {
    if (props.portalElement === undefined) return node;

    const root = props.portalElement ?? (typeof document === "undefined" ? null : document.body);
    if (!root) return false;

    return <FloatingPortal root={root}>{node}</FloatingPortal>;
  };

  if (status === "close") {
    return renderWithPortal(
      <div ref={mergedRefs} {...mergedProps} dangerouslySetInnerHTML={{ __html: innerHTML }} />,
    );
  }

  if (!props.focusManagerProps?.disabled) {
    return renderWithPortal(
      <FloatingFocusManager {...props.focusManagerProps} context={context}>
        <div ref={mergedRefs} {...mergedProps}>
          {props.children}
        </div>
      </FloatingFocusManager>,
    );
  }

  return renderWithPortal(
    <div ref={mergedRefs} {...mergedProps}>
      {props.children}
    </div>,
  );
}
