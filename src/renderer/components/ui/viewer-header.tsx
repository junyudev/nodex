import {
  forwardRef,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { ChevronDownSmIcon } from "@/components/shared/icons/plugin-detail-icons";
import { NodexDropdownMenu, type NodexDropdownMenuProps } from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  planViewerHeaderCollapse,
  viewerHeaderRequiredWidth,
  type ViewerHeaderSide,
  type ViewerHeaderSlotLayout,
} from "./viewer-header-layout";
import styles from "./viewer-controls.module.css";

export type ViewerHeaderDensity = "regular" | "compact";

export interface ViewerHeaderSlot extends ViewerHeaderSlotLayout {
  readonly content: ReactNode;
}

interface MeasuredSlot extends ViewerHeaderSlot {
  readonly side: ViewerHeaderSide;
}

export interface ViewerHeaderProps {
  readonly className?: string;
  readonly density?: ViewerHeaderDensity;
  readonly placement?: "inline" | "overlay";
  readonly label?: string;
  readonly leading: readonly ViewerHeaderSlot[];
  readonly trailing?: readonly ViewerHeaderSlot[];
}

const COLLAPSIBLE_SELECTOR = "[data-viewer-header-collapsible]";
const NO_SLOTS: readonly ViewerHeaderSlot[] = [];

/**
 * A single-row header of floating controls. When the row overflows, slot regions and then whole
 * slots collapse in ascending priority until the visible controls fit.
 */
export function ViewerHeader({
  className,
  density = "regular",
  placement,
  label,
  leading,
  trailing = NO_SLOTS,
}: ViewerHeaderProps) {
  const headerRef = useRef<HTMLElement | null>(null);
  const leadingRef = useRef<HTMLDivElement | null>(null);
  const trailingRef = useRef<HTMLDivElement | null>(null);
  const slotElements = useRef(new Map<string, HTMLDivElement>());
  const [hiddenSlotIds, setHiddenSlotIds] = useState<readonly string[]>([]);
  const [hasSides, setHasSides] = useState({ leading: false, trailing: false });
  const slots: MeasuredSlot[] = [
    ...leading.map((slot) => ({ ...slot, side: "leading" as const })),
    ...trailing.map((slot) => ({ ...slot, side: "trailing" as const })),
  ].filter((slot) => slot.content != null && slot.content !== false);
  const layoutKey = JSON.stringify(slots.map(({ content: _content, ...layout }) => layout));
  const readSlots = useEffectEvent(() => slots);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const touched = new Set<HTMLElement>();
    const reveal = (element: HTMLElement) => {
      element.style.display = "";
      element.removeAttribute("data-viewer-header-collapsed");
    };
    const measure = () => {
      const current = readSlots();
      const headerStyle = getComputedStyle(header);
      const leadingStyle = getComputedStyle(leadingRef.current ?? header);
      const trailingStyle = getComputedStyle(trailingRef.current ?? header);
      const headerWidth = header.clientWidth;
      const available =
        headerWidth -
        (Number.parseFloat(headerStyle.paddingLeft) || 0) -
        (Number.parseFloat(headerStyle.paddingRight) || 0);
      for (const element of touched) reveal(element);
      for (const slot of current) {
        const element = slotElements.current.get(slot.id);
        if ((slot.allowShrink || slot.grow) && element) {
          element.style.flex = headerWidth === 0 ? "" : "0 0 auto";
        }
      }
      const selectors = new Set([
        COLLAPSIBLE_SELECTOR,
        ...current.flatMap((slot) => slot.collapseSteps?.map((step) => step.selector) ?? []),
      ]);
      for (const selector of selectors) {
        for (const element of header.querySelectorAll<HTMLElement>(selector)) {
          touched.add(element);
          reveal(element);
        }
      }
      const widths = new Map<string, number>();
      const visible = current.filter((slot) => {
        const element = slotElements.current.get(slot.id);
        if (!element?.hasChildNodes()) return false;
        widths.set(slot.id, element.offsetWidth);
        return true;
      });
      const count = {
        leading: visible.filter((slot) => slot.side === "leading").length,
        trailing: visible.filter((slot) => slot.side === "trailing").length,
      };
      const publishSides = () =>
        setHasSides((previous) =>
          previous.leading === count.leading > 0 && previous.trailing === count.trailing > 0
            ? previous
            : { leading: count.leading > 0, trailing: count.trailing > 0 },
        );
      if (headerWidth === 0) {
        setHiddenSlotIds((previous) => (previous.length === 0 ? previous : []));
        publishSides();
        return;
      }
      const total = { leading: 0, trailing: 0 };
      for (const slot of visible) total[slot.side] += widths.get(slot.id) ?? 0;
      const gaps = {
        leading: Number.parseFloat(leadingStyle.columnGap) || 0,
        trailing: Number.parseFloat(trailingStyle.columnGap) || 0,
      };
      const required = () =>
        viewerHeaderRequiredWidth(
          { width: total.leading, count: count.leading, gap: gaps.leading },
          { width: total.trailing, count: count.trailing, gap: gaps.trailing },
        );
      const hidden: string[] = [];
      for (const step of planViewerHeaderCollapse(visible)) {
        if (required() <= available) break;
        if (step.priority === undefined || hidden.includes(step.slot.id)) continue;
        const element = slotElements.current.get(step.slot.id);
        const previousWidth = widths.get(step.slot.id) ?? 0;
        if (step.selectors) {
          for (const selector of step.selectors) {
            for (const region of element?.querySelectorAll<HTMLElement>(selector) ?? []) {
              touched.add(region);
              region.style.display = "none";
              region.setAttribute("data-viewer-header-collapsed", "");
            }
          }
          const nextWidth = element?.offsetWidth ?? 0;
          total[step.slot.side] -= previousWidth - nextWidth;
          widths.set(step.slot.id, nextWidth);
        } else {
          hidden.push(step.slot.id);
          total[step.slot.side] -= previousWidth;
          count[step.slot.side] -= 1;
        }
      }
      for (const slot of current) {
        const element = slotElements.current.get(slot.id);
        if ((slot.allowShrink || slot.grow) && element) element.style.flex = "";
      }
      publishSides();
      setHiddenSlotIds((previous) =>
        previous.length === hidden.length && previous.every((id, index) => id === hidden[index])
          ? previous
          : hidden,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    if (leadingRef.current) observer.observe(leadingRef.current, { box: "border-box" });
    if (trailingRef.current) observer.observe(trailingRef.current, { box: "border-box" });
    for (const element of slotElements.current.values()) observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      for (const element of touched) reveal(element);
    };
  }, [layoutKey]);

  const renderSide = (side: ViewerHeaderSide) => {
    const sideSlots = slots.filter((slot) => slot.side === side);
    if (sideSlots.length === 0) return null;
    return (
      <div
        ref={side === "leading" ? leadingRef : trailingRef}
        className={cn(
          "flex items-center gap-1.5",
          sideSlots.some((slot) => slot.allowShrink) ? "min-w-0 shrink" : "shrink-0",
          sideSlots.some((slot) => slot.grow) && "min-w-0 flex-1",
          side === "trailing" && "ms-auto",
        )}
      >
        {sideSlots.map((slot) => {
          const collapsed = hiddenSlotIds.includes(slot.id);
          return (
            <div
              key={slot.id}
              ref={(element) => {
                if (element) slotElements.current.set(slot.id, element);
                else slotElements.current.delete(slot.id);
              }}
              className={cn(
                "pointer-events-auto flex w-max items-center gap-1.5 empty:hidden",
                slot.allowShrink ? "min-w-0 shrink" : "shrink-0",
                slot.grow && "min-w-0 flex-1",
                collapsed && "invisible absolute start-0 top-0",
              )}
              aria-hidden={collapsed || undefined}
              inert={collapsed}
            >
              {slot.content}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <header
      ref={headerRef}
      aria-label={label}
      className={cn(
        styles.header,
        "pointer-events-none z-30 flex min-w-0 shrink-0 items-center py-2 ps-[calc(var(--spacing)*2+var(--viewer-header-start-inset,0px))] pe-2 text-sm select-none",
        className,
      )}
      data-viewer-placement={placement}
      data-viewer-density={density}
      data-testid="viewer-header"
    >
      {renderSide("leading")}
      {hasSides.leading && hasSides.trailing ? (
        <div aria-hidden="true" className="min-w-1.5 flex-1" />
      ) : null}
      {renderSide("trailing")}
    </header>
  );
}

/** A pill surface that holds one control or a group of controls. */
export const ViewerCapsule = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function ViewerCapsule({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-menu-overlay-surface="true"
        className={cn(styles.capsule, styles.controlSurface, "rounded-full", className)}
        {...props}
      />
    );
  },
);

export interface ViewerControlGroupProps extends ComponentPropsWithoutRef<"div"> {
  readonly label: string;
  readonly shrink?: boolean;
}

/** Several controls joined on one capsule, announced as a labelled group. */
export function ViewerControlGroup({
  label,
  shrink = false,
  className,
  ...props
}: ViewerControlGroupProps) {
  return (
    <ViewerCapsule
      role="group"
      aria-label={label}
      className={cn(
        styles.group,
        "inline-flex items-center border-0 text-(--color-text)",
        shrink ? "min-w-0" : "shrink-0",
        className,
      )}
      {...props}
    />
  );
}

const VIEWER_BUTTON_BASE_CLASS =
  "no-drag cursor-interaction flex items-center whitespace-nowrap select-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-offset-0 disabled:cursor-default aria-disabled:cursor-default";

export type ViewerButtonVariant = "default" | "selected" | "primary" | "dropdown";

export interface ViewerButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ViewerButtonVariant;
  /** Icon-only: a square as tall as the surrounding control row. */
  readonly uniform?: boolean;
}

/** A control on its own viewer surface, or a member of a `ViewerControlGroup`. */
export const ViewerButton = forwardRef<HTMLButtonElement, ViewerButtonProps>(function ViewerButton(
  { variant = "default", uniform = false, className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        VIEWER_BUTTON_BASE_CLASS,
        uniform && "aspect-square shrink-0 justify-center !px-0",
        styles.button,
        styles.controlSurface,
        variant === "primary" && styles.primary,
        variant === "selected" && styles.selected,
        variant === "dropdown" && styles.dropdown,
        variant === "primary"
          ? "disabled:opacity-40 aria-disabled:opacity-40"
          : "disabled:text-disabled aria-disabled:text-disabled",
        className,
      )}
      {...props}
    />
  );
});

/** A labelled icon control with its tooltip. */
export const ViewerIconButton = forwardRef<
  HTMLButtonElement,
  Omit<ViewerButtonProps, "uniform" | "aria-label"> & {
    readonly label: string;
    readonly tooltipDelayOpen?: boolean;
  }
>(function ViewerIconButton({ label, tooltipDelayOpen = false, ...props }, ref) {
  return (
    <NodexTooltip tooltipContent={label} delayOpen={tooltipDelayOpen}>
      <ViewerButton ref={ref} aria-label={label} uniform {...props} />
    </NodexTooltip>
  );
});

const COMPOUND_CONTROL_CLASS =
  "no-drag cursor-interaction flex items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-2 py-0.5 text-sm leading-[18px] text-(--color-text) select-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40 not-disabled:not-aria-disabled:hover:bg-(--color-background-primary-ghost-hover) data-[popup-open]:bg-(--color-background-primary-ghost-hover)";

export interface ViewerSplitButtonProps {
  readonly label: string;
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly menuLabel: string;
  readonly menu: ReactNode;
  readonly disabled?: boolean;
  readonly menuAlign?: NodexDropdownMenuProps["align"];
  readonly onMenuOpenChange?: (open: boolean) => void;
}

/** A primary action joined to a menu of alternatives on one pill surface. */
export function ViewerSplitButton({
  label,
  children,
  onClick,
  menuLabel,
  menu,
  disabled = false,
  menuAlign = "end",
  onMenuOpenChange,
}: ViewerSplitButtonProps) {
  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-stretch self-start overflow-hidden rounded-full",
        styles.compound,
        styles.controlSurface,
      )}
    >
      <NodexTooltip tooltipContent={label}>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            COMPOUND_CONTROL_CLASS,
            "rounded-e-none border-e-0 pe-1",
            styles.compoundControl,
          )}
        >
          <span className="flex items-center gap-1.5">{children}</span>
        </button>
      </NodexTooltip>
      <NodexDropdownMenu
        align={menuAlign}
        disabled={disabled}
        onOpenChange={onMenuOpenChange}
        triggerTooltipContent={menuLabel}
        triggerButton={
          <button
            type="button"
            aria-label={menuLabel}
            className={cn(
              COMPOUND_CONTROL_CLASS,
              "gap-0 rounded-s-none border-s-0 ps-0.5 pe-1.5",
              styles.compoundControl,
            )}
          >
            <ChevronDownSmIcon className="icon-2xs opacity-50" />
          </button>
        }
      >
        {menu}
      </NodexDropdownMenu>
    </div>
  );
}
