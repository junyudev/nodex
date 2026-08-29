import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  forwardRef,
  isValidElement,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CheckmarkIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SearchIcon,
} from "@/components/shared/icons";
import { APP_SHELL_FLOATING_UI_LAYER_CLASS } from "@/lib/app-shell-layers";
import { cn } from "@/lib/utils";
import { NODEX_RAISED_CONTROL_CHROME_CLASS_NAME } from "./control-chrome";
import { NodexFloatingLayerProvider, useNodexFloatingLayerIndex } from "./floating-layer";
import { makeNodexFloatingSurfaceBoundaryStyle } from "./floating-surface";
import { handleNodexMenuItemClick, type NodexMenuSelectHandler } from "./menu-selection";
import { nodexMenuSurfaceClassName } from "./menu-surface";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "./popover";
import { NodexTooltip } from "./tooltip";

export type NodexDropdownSurface = "menu" | "panel";
export type NodexDropdownFinalFocus =
  | boolean
  | RefObject<HTMLElement | null>
  | (() => boolean | HTMLElement | null | void);
export type NodexDropdownContentWidth =
  | "icon"
  | "xs"
  | "sm"
  | "menu"
  | "menuFixed"
  | "menuBounded"
  | "menuWide"
  | "workspace"
  | "panel"
  | "panelWide";
export type NodexDropdownContentMaxHeight = "list" | "tall" | "halfViewport";

type NodexMenuBoundaryStyle = CSSProperties & {
  "--nodex-menu-transform-origin": string;
};

const CONTENT_BOUNDARY_STYLE: NodexMenuBoundaryStyle = {
  ...makeNodexFloatingSurfaceBoundaryStyle(
    "var(--available-width)",
    "var(--available-height)",
    "var(--anchor-width)",
    "var(--anchor-height)",
  ),
  "--nodex-menu-transform-origin": "var(--transform-origin)",
  maxWidth: "min(var(--nodex-floating-surface-available-width), calc(100vw - 16px))",
  maxHeight: "min(var(--nodex-floating-surface-available-height), calc(100vh - 16px))",
};

export interface NodexDropdownRootProps {
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
  loopFocus?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
}

export function NodexDropdownRoot({
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: NodexDropdownRootProps) {
  return (
    <MenuPrimitive.Root
      modal={false}
      {...props}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
      onOpenChangeComplete={onOpenChangeComplete ? (open) => onOpenChangeComplete(open) : undefined}
    />
  );
}

export interface NodexDropdownTriggerProps {
  children: ReactElement;
  disabled?: boolean;
  className?: string;
  nativeButton?: boolean;
  openOnHover?: boolean;
  delay?: number;
  closeDelay?: number;
}

export const NodexDropdownTrigger = forwardRef<HTMLButtonElement, NodexDropdownTriggerProps>(
  function NodexDropdownTrigger({ children, className, disabled, nativeButton, ...props }, ref) {
    if (!isValidElement(children)) {
      throw new Error("NodexDropdownTrigger requires one concrete interactive child");
    }

    return (
      <MenuPrimitive.Trigger
        ref={ref}
        data-slot="dropdown-trigger"
        render={children}
        disabled={disabled}
        nativeButton={nativeButton ?? children.type === "button"}
        className={cn("outline-hidden", !disabled && "cursor-interaction", className)}
        {...props}
      />
    );
  },
);

export interface NodexDropdownPortalProps {
  children?: ReactNode;
  container?: HTMLElement | ShadowRoot | RefObject<HTMLElement | ShadowRoot | null> | null;
  keepMounted?: boolean;
}

export function NodexDropdownPortal(props: NodexDropdownPortalProps) {
  return <MenuPrimitive.Portal data-slot="dropdown-portal" {...props} />;
}

interface NodexDropdownSubmenuProps {
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function NodexDropdownSubmenu({ onOpenChange, ...props }: NodexDropdownSubmenuProps) {
  return (
    <MenuPrimitive.SubmenuRoot
      {...props}
      onOpenChange={onOpenChange ? (open) => onOpenChange(open) : undefined}
    />
  );
}

interface NodexDropdownSubmenuTriggerProps extends ComponentPropsWithoutRef<"div"> {
  disabled?: boolean;
  openOnHover?: boolean;
  delay?: number;
  closeDelay?: number;
}

const NodexDropdownSubmenuTrigger = forwardRef<HTMLDivElement, NodexDropdownSubmenuTriggerProps>(
  function NodexDropdownSubmenuTrigger({ className, ...props }, ref) {
    return (
      <MenuPrimitive.SubmenuTrigger
        ref={ref}
        data-slot="dropdown-submenu-trigger"
        className={cn(dropdownItemBaseClassName, dropdownItemInteractiveClassName, className)}
        {...props}
      />
    );
  },
);

interface NodexDropdownSubmenuContentProps extends ComponentPropsWithoutRef<"div"> {
  align?: "start" | "center" | "end";
  alignOffset?: number;
  sideOffset?: number;
  collisionPadding?: number;
  surface?: NodexDropdownSurface | "bare";
  motion?: "default" | "none";
}

const NodexDropdownSubmenuContent = forwardRef<HTMLDivElement, NodexDropdownSubmenuContentProps>(
  function NodexDropdownSubmenuContent(
    {
      className,
      children,
      style,
      collisionPadding = 6,
      sideOffset = 4,
      alignOffset = -4,
      surface = "menu",
      motion = "none",
      ...props
    },
    ref,
  ) {
    const layerIndex = useNodexFloatingLayerIndex(style?.zIndex);

    return (
      <MenuPrimitive.Positioner
        data-slot="dropdown-submenu-positioner"
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        className={APP_SHELL_FLOATING_UI_LAYER_CLASS}
        style={{ zIndex: layerIndex }}
      >
        <MenuPrimitive.Popup
          ref={ref}
          data-slot="dropdown-submenu-content"
          style={{ ...CONTENT_BOUNDARY_STYLE, zIndex: layerIndex, ...style }}
          className={cn(
            surface === "bare"
              ? cn(
                  "m-0 flex min-w-[180px] select-none flex-col overflow-x-hidden overflow-y-auto p-0",
                  APP_SHELL_FLOATING_UI_LAYER_CLASS,
                )
              : cn(
                  dropdownContentSurfaceClassName,
                  surface === "menu" && dropdownAdaptiveWidthClassName,
                ),
            motion === "default"
              ? dropdownContentMotionClassName
              : "data-closed:invisible data-closed:pointer-events-none",
            className,
          )}
          {...props}
          data-nodex-keyboard-scope="local"
        >
          <NodexFloatingLayerProvider zIndex={layerIndex}>{children}</NodexFloatingLayerProvider>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    );
  },
);

const dropdownContentSurfaceClassName = cn(
  nodexMenuSurfaceClassName,
  "[transform-origin:var(--nodex-menu-transform-origin)] [will-change:opacity,transform]",
);

const dropdownItemBaseClassName =
  "text-token-foreground outline-hidden rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm";
const dropdownItemInteractiveClassName =
  "hover:bg-token-list-hover-background focus:bg-token-list-hover-background cursor-interaction";
const dropdownItemLeftSlotClassName =
  "shrink-0 text-token-text-secondary [&_svg]:size-4 [&_svg]:shrink-0";
const dropdownItemLeftSlotInteractiveClassName =
  "group-focus:text-token-foreground group-hover:text-token-foreground";
const dropdownSectionLabelClassName =
  "px-[var(--padding-row-x)] py-1 text-sm text-token-description-foreground";
const dropdownMessageClassName = "px-[var(--padding-row-x)] text-sm";
const dropdownTitleClassName =
  "text-token-description-foreground flex min-h-6 items-center truncate px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm leading-4";
const dropdownSeparatorClassName = "w-full px-[var(--padding-row-x)] py-1";
const dropdownContentMotionClassName = cn(
  "[--dropdown-entry-transform:translateY(calc(var(--dropdown-translate)_*_-1))_scale(var(--dropdown-scale))]",
  "data-[side=top]:[--dropdown-entry-transform:translateY(calc(var(--dropdown-translate)_*_1))_scale(var(--dropdown-scale))]",
  "data-[side=right]:[--dropdown-entry-transform:translateX(calc(var(--dropdown-translate)_*_-1))_scale(var(--dropdown-scale))]",
  "data-[side=left]:[--dropdown-entry-transform:translateX(calc(var(--dropdown-translate)_*_1))_scale(var(--dropdown-scale))]",
  "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[var(--dropdown-scale)] data-[side=bottom]:data-open:slide-in-from-top-[var(--dropdown-translate)] data-[side=left]:data-open:slide-in-from-right-[var(--dropdown-translate)] data-[side=right]:data-open:slide-in-from-left-[var(--dropdown-translate)] data-[side=top]:data-open:slide-in-from-bottom-[var(--dropdown-translate)]",
  "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[var(--dropdown-scale)]",
);

function resolveDropdownSurfaceClass(surface: NodexDropdownSurface): string | undefined {
  if (surface === "panel") return "rounded-2xl p-4 shadow-2xl backdrop-blur-lg";
  return undefined;
}

const dropdownAdaptiveWidthClassName = "min-w-[172px] max-w-[240px]";

function resolveDropdownWidthClass(width?: NodexDropdownContentWidth): string {
  if (width === "icon") return "min-w-[120px] max-w-[240px]";
  if (width === "xs") return "min-w-[160px] max-w-[240px]";
  if (width === "sm") return "min-w-[180px] max-w-[240px]";
  if (width === "menu") return "min-w-[220px] max-w-[320px]";
  if (width === "menuFixed") return "w-[220px]";
  if (width === "menuBounded") return "min-w-[200px] max-w-[320px]";
  if (width === "menuWide") return "w-[240px]";
  if (width === "workspace") return "min-w-[260px] max-w-[360px]";
  if (width === "panel") return "w-[280px]";
  if (width === "panelWide") return "w-[360px]";
  return dropdownAdaptiveWidthClassName;
}

function resolveDropdownMaxHeightClass(
  maxHeight?: NodexDropdownContentMaxHeight,
): string | undefined {
  if (maxHeight === "list") return "max-h-[250px]";
  if (maxHeight === "tall") return "max-h-[350px]";
  if (maxHeight === "halfViewport") return "max-h-[50vh]";
  return undefined;
}

export interface NodexDropdownMenuProps {
  triggerButton: ReactElement;
  triggerTooltipContent?: ReactNode;
  triggerTooltipShortcutLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  finalFocus?: NodexDropdownFinalFocus;
  contentClassName?: string;
  contentStyle?: CSSProperties;
  surface?: NodexDropdownSurface;
  contentWidth?: NodexDropdownContentWidth;
  contentMaxHeight?: NodexDropdownContentMaxHeight;
  portalContainer?: HTMLElement | null;
  motion?: "default" | "none";
}

export function NodexDropdownMenu({
  triggerButton,
  triggerTooltipContent,
  triggerTooltipShortcutLabel,
  children,
  disabled = false,
  open,
  onOpenChange,
  side,
  align = "start",
  sideOffset = 4,
  alignOffset,
  finalFocus,
  contentClassName,
  contentStyle,
  surface = "menu",
  contentWidth,
  contentMaxHeight,
  portalContainer,
  motion = "default",
}: NodexDropdownMenuProps) {
  const trigger = (
    <NodexDropdownTrigger disabled={disabled} nativeButton>
      {triggerButton}
    </NodexDropdownTrigger>
  );

  return (
    <NodexDropdownRoot open={open} onOpenChange={onOpenChange}>
      {triggerTooltipContent == null ? (
        trigger
      ) : (
        <NodexTooltip
          tooltipContent={triggerTooltipContent}
          shortcutLabel={triggerTooltipShortcutLabel}
          side="top"
          sideOffset={4}
        >
          {trigger}
        </NodexTooltip>
      )}
      {disabled ? null : (
        <NodexDropdownPortal container={portalContainer ?? undefined}>
          <NodexDropdownContent
            side={side}
            align={align}
            sideOffset={sideOffset}
            alignOffset={alignOffset}
            finalFocus={finalFocus}
            style={contentStyle}
            className={cn(
              resolveDropdownWidthClass(contentWidth),
              resolveDropdownMaxHeightClass(contentMaxHeight),
              contentClassName,
            )}
            surface={surface}
            motion={motion}
          >
            {children}
          </NodexDropdownContent>
        </NodexDropdownPortal>
      )}
    </NodexDropdownRoot>
  );
}

export interface NodexDropdownContentProps extends ComponentPropsWithoutRef<"div"> {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number;
  finalFocus?: NodexDropdownFinalFocus;
  surface?: NodexDropdownSurface;
  motion?: "default" | "none";
}

export const NodexDropdownContent = forwardRef<HTMLDivElement, NodexDropdownContentProps>(
  function NodexDropdownContent(
    {
      children,
      className,
      align = "start",
      surface = "menu",
      motion = "default",
      style,
      collisionPadding = 6,
      side,
      sideOffset,
      alignOffset,
      finalFocus,
      ...props
    },
    ref,
  ) {
    const layerIndex = useNodexFloatingLayerIndex(style?.zIndex);

    return (
      <MenuPrimitive.Positioner
        data-slot="dropdown-positioner"
        align={align}
        side={side}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className={APP_SHELL_FLOATING_UI_LAYER_CLASS}
        style={{ zIndex: layerIndex }}
      >
        <MenuPrimitive.Popup
          ref={ref}
          data-slot="dropdown-content"
          finalFocus={finalFocus}
          style={{ ...CONTENT_BOUNDARY_STYLE, zIndex: layerIndex, ...style }}
          className={cn(
            dropdownContentSurfaceClassName,
            motion === "default"
              ? dropdownContentMotionClassName
              : "data-closed:invisible data-closed:pointer-events-none",
            resolveDropdownSurfaceClass(surface),
            className,
          )}
          {...props}
          data-nodex-keyboard-scope="local"
        >
          <NodexFloatingLayerProvider zIndex={layerIndex}>{children}</NodexFloatingLayerProvider>
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    );
  },
);

export type NodexDropdownButtonTriggerProps = Omit<ComponentPropsWithoutRef<"button">, "title"> & {
  size?: "xs" | "sm" | "default" | "rule" | "settings";
  muted?: boolean;
  showChevron?: boolean;
  chrome?: "filled" | "transparent" | "outline" | "raised";
  shape?: "default" | "pill";
};

export const NodexDropdownButtonTrigger = forwardRef<
  HTMLButtonElement,
  NodexDropdownButtonTriggerProps
>(function NodexDropdownButtonTrigger(
  {
    className,
    children,
    type = "button",
    size = "default",
    muted = false,
    showChevron = true,
    chrome = "outline",
    shape = "default",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex min-w-0 items-center justify-between gap-1 border-[0.5px] outline-hidden disabled:cursor-not-allowed disabled:opacity-40",
        chrome === "outline"
          ? "border-token-border bg-token-bg-fog hover:bg-token-list-hover-background"
          : chrome === "raised"
            ? NODEX_RAISED_CONTROL_CHROME_CLASS_NAME
            : chrome === "filled"
              ? "border-transparent bg-token-foreground/5 hover:bg-token-foreground/10"
              : "border-transparent bg-transparent hover:bg-token-foreground/5",
        "focus-visible:ring-token-focus focus-visible:ring-2",
        muted ? "text-token-description-foreground" : "text-token-foreground",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-token-description-foreground",
        size === "xs"
          ? "h-6 rounded-md px-2 py-0 text-xs"
          : size === "sm"
            ? "h-7 rounded-lg px-2 py-0 text-sm/4.5"
            : size === "rule"
              ? "h-8 rounded-lg px-2 py-0 text-sm/5"
              : size === "settings"
                ? "h-token-button-composer rounded-lg px-3 py-0 text-base leading-[18px]"
                : "h-7 rounded-lg px-2 py-0 text-sm/4.5",
        shape === "pill" && "rounded-full pl-1 pr-2",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1">{children}</span>
      {showChevron ? <ChevronDownIcon className="icon-2xs" /> : null}
    </button>
  );
});

export const NodexSettingsDropdownTrigger = forwardRef<
  HTMLButtonElement,
  Omit<NodexDropdownButtonTriggerProps, "chrome" | "size">
>(function NodexSettingsDropdownTrigger(props, ref) {
  return <NodexDropdownButtonTrigger ref={ref} chrome="outline" size="settings" {...props} />;
});

export interface NodexDropdownItemProps extends Omit<ComponentPropsWithoutRef<"div">, "onSelect"> {
  disabled?: boolean;
  focusableWhenDisabled?: boolean;
  onSelect?: NodexMenuSelectHandler;
  closeOnClick?: boolean;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  subText?: ReactNode;
  keyboardShortcut?: ReactNode;
  tooltipText?: ReactNode;
  tooltipTextClassName?: string;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  tooltipAlign?: "start" | "center" | "end";
  allowWrap?: boolean;
  subTextAllowWrap?: boolean;
  alignSlotsToStart?: boolean;
}

export const NodexDropdownItem = forwardRef<HTMLDivElement, NodexDropdownItemProps>(
  function NodexDropdownItem(
    {
      children,
      leftSlot,
      rightSlot,
      subText,
      keyboardShortcut,
      tooltipText,
      tooltipTextClassName,
      tooltipSide = "right",
      tooltipAlign,
      allowWrap = false,
      subTextAllowWrap = false,
      alignSlotsToStart = false,
      className,
      disabled = false,
      focusableWhenDisabled = false,
      closeOnClick,
      onClick,
      onSelect,
      ...props
    },
    ref,
  ) {
    const item = (
      <MenuPrimitive.Item
        ref={ref}
        data-slot="dropdown-item"
        disabled={disabled && !focusableWhenDisabled}
        aria-disabled={disabled || undefined}
        data-disabled={disabled ? "" : undefined}
        closeOnClick={disabled && focusableWhenDisabled ? false : closeOnClick}
        onClick={
          disabled
            ? focusableWhenDisabled
              ? (event) => event.preventDefault()
              : undefined
            : (event) => handleNodexMenuItemClick(event, onClick, onSelect)
        }
        className={cn(
          "no-drag",
          dropdownItemBaseClassName,
          !disabled && dropdownItemInteractiveClassName,
          "group flex flex-col",
          disabled && "cursor-default opacity-50",
          className,
        )}
        {...props}
      >
        <div className={cn("flex w-full items-center gap-1.5", alignSlotsToStart && "items-start")}>
          {leftSlot ? (
            <span
              className={cn(
                dropdownItemLeftSlotClassName,
                !disabled && dropdownItemLeftSlotInteractiveClassName,
              )}
            >
              {leftSlot}
            </span>
          ) : null}
          <span className={cn("min-w-0 flex-1", allowWrap ? "whitespace-normal" : "truncate")}>
            <span
              className={cn("flex items-center gap-1", subText && "flex-col items-start gap-0.5")}
            >
              <span className={cn("min-w-0", !allowWrap && "truncate")}>{children}</span>
              {subText ? (
                <span
                  className={cn(
                    "min-w-0 text-token-description-foreground",
                    subTextAllowWrap ? "whitespace-normal text-sm" : "truncate text-xs",
                  )}
                >
                  {subText}
                </span>
              ) : null}
            </span>
          </span>
          {keyboardShortcut ? (
            <span className="ml-2 shrink-0 text-xs text-token-description-foreground">
              {keyboardShortcut}
            </span>
          ) : null}
          {rightSlot ? <span className="shrink-0">{rightSlot}</span> : null}
        </div>
      </MenuPrimitive.Item>
    );

    if (!tooltipText) return item;

    return (
      <NodexTooltip
        tooltipContent={
          <div className={cn("max-w-64 text-pretty", tooltipTextClassName)}>{tooltipText}</div>
        }
        side={tooltipSide}
        align={tooltipAlign}
        tooltipBodyClassName={tooltipTextClassName}
      >
        {item}
      </NodexTooltip>
    );
  },
);

export interface NodexDropdownRadioGroupProps extends ComponentPropsWithoutRef<"div"> {
  value?: string;
  onValueChange?: (value: string) => void;
}

export function NodexDropdownRadioGroup({ onValueChange, ...props }: NodexDropdownRadioGroupProps) {
  return (
    <MenuPrimitive.RadioGroup
      {...props}
      onValueChange={onValueChange ? (value) => onValueChange(value) : undefined}
    />
  );
}

export interface NodexDropdownRadioItemProps extends Omit<
  ComponentPropsWithoutRef<"div">,
  "onSelect"
> {
  value: string;
  disabled?: boolean;
  onSelect?: NodexMenuSelectHandler;
  closeOnClick?: boolean;
  leftSlot?: ReactNode;
  rightSlot?: ReactElement;
  allowWrap?: boolean;
}

export const NodexDropdownRadioItem = forwardRef<HTMLDivElement, NodexDropdownRadioItemProps>(
  function NodexDropdownRadioItem(
    {
      children,
      leftSlot,
      rightSlot,
      allowWrap = false,
      className,
      disabled = false,
      onClick,
      onSelect,
      ...props
    },
    ref,
  ) {
    return (
      <MenuPrimitive.RadioItem
        ref={ref}
        data-slot="dropdown-radio-item"
        disabled={disabled}
        closeOnClick
        onClick={
          disabled ? undefined : (event) => handleNodexMenuItemClick(event, onClick, onSelect)
        }
        className={cn(
          "no-drag",
          dropdownItemBaseClassName,
          !disabled && dropdownItemInteractiveClassName,
          "group flex flex-col",
          disabled && "cursor-default opacity-50",
          className,
        )}
        {...props}
      >
        <div className="flex w-full items-center gap-1.5">
          {leftSlot ? (
            <span
              className={cn(
                dropdownItemLeftSlotClassName,
                !disabled && dropdownItemLeftSlotInteractiveClassName,
              )}
            >
              {leftSlot}
            </span>
          ) : null}
          <span className={cn("min-w-0 flex-1", allowWrap ? "whitespace-normal" : "truncate")}>
            <span className={cn("min-w-0", !allowWrap && "truncate")}>{children}</span>
          </span>
          <MenuPrimitive.RadioItemIndicator render={rightSlot ?? <NodexDropdownSelectedIcon />} />
        </div>
      </MenuPrimitive.RadioItem>
    );
  },
);

export type NodexOptionPickerSearchMode = "none" | "filter";

export interface NodexOptionPickerOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly searchText?: string;
  readonly leftSlot?: ReactNode;
  readonly subText?: ReactNode;
  readonly tooltipText?: ReactNode;
  readonly disabled?: boolean;
  readonly allowWrap?: boolean;
}

export interface NodexOptionPickerProps {
  readonly triggerButton: ReactElement;
  readonly value: string;
  readonly options: readonly NodexOptionPickerOption[];
  readonly onValueChange: (value: string) => void;
  readonly search?: NodexOptionPickerSearchMode;
  readonly searchPlaceholder?: string;
  readonly searchAriaLabel?: string;
  readonly title?: ReactNode;
  readonly emptyMessage?: ReactNode;
  readonly noResultsMessage?: ReactNode;
  readonly disabled?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  readonly sideOffset?: number;
  readonly alignOffset?: number;
  readonly contentClassName?: string;
  readonly contentStyle?: CSSProperties;
  readonly contentWidth?: NodexDropdownContentWidth;
  readonly contentMaxHeight?: NodexDropdownContentMaxHeight;
  readonly portalContainer?: HTMLElement | null;
}

function NodexStaticOptionPicker({
  value,
  options,
  onValueChange,
  title,
  emptyMessage,
  triggerButton,
  disabled,
  open,
  onOpenChange,
  side,
  align,
  sideOffset,
  alignOffset,
  contentClassName,
  contentStyle,
  contentWidth,
  contentMaxHeight,
  portalContainer,
}: NodexOptionPickerProps) {
  return (
    <NodexDropdownMenu
      triggerButton={triggerButton}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      side={side}
      align={align}
      sideOffset={sideOffset}
      alignOffset={alignOffset}
      contentClassName={contentClassName}
      contentStyle={contentStyle}
      contentWidth={contentWidth}
      contentMaxHeight={contentMaxHeight}
      portalContainer={portalContainer}
    >
      {title ? <NodexDropdownTitle>{title}</NodexDropdownTitle> : null}
      {options.length === 0 ? (
        <NodexDropdownMessage compact>{emptyMessage}</NodexDropdownMessage>
      ) : (
        options.map((option) => (
          <NodexDropdownItem
            key={option.value}
            onSelect={() => onValueChange(option.value)}
            disabled={option.disabled}
            leftSlot={option.leftSlot}
            subText={option.subText}
            tooltipText={option.tooltipText}
            allowWrap={option.allowWrap}
            rightSlot={option.value === value ? <NodexDropdownSelectedIcon /> : null}
          >
            {option.label}
          </NodexDropdownItem>
        ))
      )}
    </NodexDropdownMenu>
  );
}

const normalizeOptionPickerSearchText = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase();

const stringNode = (value: ReactNode): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
};

const optionPickerSearchValue = (option: NodexOptionPickerOption): string =>
  normalizeOptionPickerSearchText(
    [option.searchText, stringNode(option.label), stringNode(option.subText), option.value]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );

const filterOptionPickerOptions = (
  options: readonly NodexOptionPickerOption[],
  query: string,
): readonly NodexOptionPickerOption[] => {
  const terms = normalizeOptionPickerSearchText(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return options;
  return options.filter((option) => {
    const searchValue = optionPickerSearchValue(option);
    return terms.every((term) => searchValue.includes(term));
  });
};

function NodexFilterOptionButton({
  id,
  option,
  selected,
  onKeyDown,
  onSelect,
}: {
  readonly id: string;
  readonly option: NodexOptionPickerOption;
  readonly selected: boolean;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onSelect: () => void;
}) {
  const button = (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
      disabled={option.disabled}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "no-drag group flex w-full flex-col",
        dropdownItemBaseClassName,
        !option.disabled && dropdownItemInteractiveClassName,
        option.disabled && "cursor-default opacity-50",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        {option.leftSlot ? (
          <span
            className={cn(
              dropdownItemLeftSlotClassName,
              !option.disabled && dropdownItemLeftSlotInteractiveClassName,
            )}
          >
            {option.leftSlot}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 text-left",
            option.allowWrap ? "whitespace-normal" : "truncate",
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1",
              option.subText && "flex-col items-start gap-0.5",
            )}
          >
            <span className={cn("min-w-0", !option.allowWrap && "truncate")}>{option.label}</span>
            {option.subText ? (
              <span className="min-w-0 truncate text-xs text-token-description-foreground">
                {option.subText}
              </span>
            ) : null}
          </span>
        </span>
        {selected ? <NodexDropdownSelectedIcon /> : null}
      </span>
    </button>
  );

  if (!option.tooltipText) return button;

  return (
    <NodexTooltip tooltipContent={option.tooltipText} side="right">
      {button}
    </NodexTooltip>
  );
}

function NodexFilterOptionPicker({
  triggerButton,
  value,
  options,
  onValueChange,
  searchPlaceholder = "Search options…",
  searchAriaLabel,
  title,
  emptyMessage,
  noResultsMessage,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  side,
  align = "start",
  sideOffset = 4,
  alignOffset,
  contentClassName,
  contentStyle,
  contentWidth,
  contentMaxHeight,
  portalContainer,
}: NodexOptionPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const open = controlledOpen ?? uncontrolledOpen;
  const effectiveQuery = open ? query : "";
  const filteredOptions = filterOptionPickerOptions(options, effectiveQuery);
  const enabledOptions = filteredOptions.filter((option) => !option.disabled);

  const changeOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    if (!next) setQuery("");
    onOpenChange?.(next);
  };

  const chooseOption = (option: NodexOptionPickerOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    changeOpen(false);
  };

  const focusOptionAt = (index: number) => {
    const optionElements = listboxRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="option"]:not(:disabled)',
    );
    if (!optionElements || optionElements.length === 0) return;
    optionElements[Math.max(0, Math.min(index, optionElements.length - 1))]?.focus();
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      changeOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOptionAt(0);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOptionAt(enabledOptions.length - 1);
      return;
    }
    if (event.key !== "Enter" || enabledOptions.length !== 1) return;
    event.preventDefault();
    chooseOption(enabledOptions[0]!);
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const optionElements = Array.from(
      listboxRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ??
        [],
    );
    const currentIndex = optionElements.indexOf(event.currentTarget);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      optionElements[(currentIndex + 1) % optionElements.length]?.focus();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      optionElements[(currentIndex - 1 + optionElements.length) % optionElements.length]?.focus();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      optionElements[0]?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      optionElements.at(-1)?.focus();
    }
  };

  return (
    <NodexPopover open={open} onOpenChange={changeOpen}>
      <NodexPopoverTrigger disabled={disabled}>{triggerButton}</NodexPopoverTrigger>
      {disabled ? null : (
        <NodexPopoverContent
          align={align}
          side={side}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          portalContainer={portalContainer}
          initialFocus={inputRef}
          className={cn(
            "overflow-hidden p-1",
            resolveDropdownWidthClass(contentWidth),
            contentClassName,
          )}
          style={contentStyle}
        >
          {title ? <NodexDropdownTitle>{title}</NodexDropdownTitle> : null}
          <NodexDropdownSearchInput
            ref={inputRef}
            role="combobox"
            aria-label={searchAriaLabel ?? searchPlaceholder}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            placeholder={searchPlaceholder}
            value={effectiveQuery}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <div
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label={typeof title === "string" ? title : "Options"}
            className={cn(
              "flex flex-col overflow-y-auto",
              contentMaxHeight === "halfViewport"
                ? "max-h-[50vh]"
                : contentMaxHeight === "tall"
                  ? "max-h-[350px]"
                  : "max-h-[250px]",
            )}
          >
            {options.length === 0 ? (
              <NodexDropdownMessage compact>{emptyMessage}</NodexDropdownMessage>
            ) : filteredOptions.length === 0 ? (
              <NodexDropdownMessage compact>{noResultsMessage}</NodexDropdownMessage>
            ) : (
              filteredOptions.map((option, index) => (
                <NodexFilterOptionButton
                  key={option.value}
                  id={`${listboxId}-option-${index}`}
                  option={option}
                  selected={option.value === value}
                  onKeyDown={handleOptionKeyDown}
                  onSelect={() => chooseOption(option)}
                />
              ))
            )}
          </div>
        </NodexPopoverContent>
      )}
    </NodexPopover>
  );
}

export function NodexOptionPicker({
  search = "none",
  emptyMessage = "No options available",
  noResultsMessage = "No matching options",
  ...props
}: NodexOptionPickerProps) {
  const pickerProps = { ...props, search, emptyMessage, noResultsMessage };
  if (search === "filter") return <NodexFilterOptionPicker {...pickerProps} />;
  return <NodexStaticOptionPicker {...pickerProps} />;
}

export const NodexDropdownInput = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(
  function NodexDropdownInput({ className, onKeyDown, ...props }, ref) {
    return (
      <input
        ref={ref}
        autoFocus
        className={cn(
          "text-md w-full min-w-0 rounded-sm border border-none px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm !outline-none",
          className,
        )}
        onKeyDown={(event) => {
          event.stopPropagation();
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            event.currentTarget.select();
            return;
          }
          onKeyDown?.(event);
        }}
        {...props}
      />
    );
  },
);

export const NodexDropdownSearchInput = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<typeof NodexDropdownInput> & {
    inputClassName?: string;
    trailingContent?: ReactNode;
  }
>(function NodexDropdownSearchInput({ className, inputClassName, trailingContent, ...props }, ref) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-1.5 px-[var(--padding-row-x)] py-[var(--padding-row-y)]",
        className,
      )}
    >
      <SearchIcon className="icon-2xs shrink-0 text-token-text-tertiary" />
      <NodexDropdownInput
        ref={ref}
        className={cn(
          "!w-auto flex-1 appearance-none !rounded-none !border-none bg-transparent !px-0 !py-0 text-token-foreground placeholder:text-token-input-placeholder-foreground",
          inputClassName,
        )}
        {...props}
      />
      {trailingContent ? <div className="shrink-0">{trailingContent}</div> : null}
    </div>
  );
});

export function NodexDropdownSeparator({
  className,
  paddingClassName = "py-1",
}: {
  className?: string;
  paddingClassName?: string;
}) {
  return (
    <div className={cn(dropdownSeparatorClassName, paddingClassName, className)}>
      <div className="h-[1px] w-full bg-token-menu-border" />
    </div>
  );
}

export const NodexDropdownSurface = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function NodexDropdownSurface({ children, className, style, ...props }, ref) {
    const layerIndex = useNodexFloatingLayerIndex(style?.zIndex);

    return (
      <div
        ref={ref}
        className={cn(dropdownContentSurfaceClassName, className)}
        style={{ zIndex: layerIndex, ...style }}
        {...props}
      >
        <NodexFloatingLayerProvider zIndex={layerIndex}>{children}</NodexFloatingLayerProvider>
      </div>
    );
  },
);

export const NodexDropdownScrollList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function NodexDropdownScrollList({ children, className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex max-h-[250px] flex-col overflow-y-auto", className)}
        {...props}
      >
        {children}
      </div>
    );
  },
);

export const NodexDropdownActionRow = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button">
>(function NodexDropdownActionRow({ children, className, disabled = false, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        "no-drag",
        dropdownItemBaseClassName,
        !disabled && dropdownItemInteractiveClassName,
        "focus-visible:bg-token-list-hover-background cursor-interaction flex w-full data-disabled:pointer-events-none",
        disabled && "cursor-default opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export function NodexDropdownSectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(dropdownSectionLabelClassName, className)}>{children}</div>;
}

export function NodexDropdownMessage({
  children,
  className,
  tone = "muted",
  compact = false,
  centered = false,
}: {
  children: ReactNode;
  className?: string;
  tone?: "muted" | "error";
  compact?: boolean;
  centered?: boolean;
}) {
  return (
    <div
      className={cn(
        dropdownMessageClassName,
        compact ? "py-2" : "py-3",
        tone === "error" ? "text-token-error-foreground" : "text-token-description-foreground",
        centered && "self-center text-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function NodexDropdownTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn(dropdownTitleClassName, className)}>{children}</div>;
}

export function NodexDropdownSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
}

export function NodexDropdownFlyoutSubmenuItem({
  ariaLabel,
  label,
  children,
  leftSlot,
  className,
  disabled = false,
  contentClassName,
  contentSurface = "menu",
  contentMotion = "default",
  onSelect,
  triggerContent,
  tooltipText,
  tooltipTextClassName,
  tooltipSide,
  tooltipAlign,
  onOpenChange,
  open,
}: {
  ariaLabel?: string;
  label: ReactNode;
  children: ReactNode;
  leftSlot?: ReactNode;
  className?: string;
  disabled?: boolean;
  contentClassName?: string;
  contentSurface?: NodexDropdownSurface | "bare";
  contentMotion?: "default" | "none";
  onSelect?: () => void;
  triggerContent?: ReactNode;
  tooltipText?: ReactNode;
  tooltipTextClassName?: string;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  tooltipAlign?: "start" | "center" | "end";
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}) {
  const trigger = (
    <NodexDropdownSubmenuTrigger
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        "group flex w-full items-center",
        disabled && "cursor-default opacity-50",
        className,
      )}
      onClick={(event) => {
        if (disabled || !onSelect) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      }}
    >
      {triggerContent ?? (
        <div className="flex w-full items-center gap-1.5">
          {leftSlot ? (
            <span
              className={cn(
                dropdownItemLeftSlotClassName,
                !disabled && dropdownItemLeftSlotInteractiveClassName,
              )}
            >
              {leftSlot}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronRightIcon className="icon-xs shrink-0 text-token-input-placeholder-foreground opacity-75 group-focus:opacity-100 group-hover:opacity-100" />
        </div>
      )}
    </NodexDropdownSubmenuTrigger>
  );

  return (
    <NodexDropdownSubmenu open={open} onOpenChange={onOpenChange}>
      {tooltipText ? (
        <NodexTooltip
          tooltipContent={
            <div className={cn("max-w-64 text-pretty", tooltipTextClassName)}>{tooltipText}</div>
          }
          side={tooltipSide ?? "right"}
          align={tooltipAlign}
          tooltipBodyClassName={tooltipTextClassName}
        >
          {trigger}
        </NodexTooltip>
      ) : (
        trigger
      )}
      <NodexDropdownPortal>
        <NodexDropdownSubmenuContent
          surface={contentSurface}
          motion={contentMotion}
          className={contentClassName}
        >
          <div dir="ltr">{children}</div>
        </NodexDropdownSubmenuContent>
      </NodexDropdownPortal>
    </NodexDropdownSubmenu>
  );
}

export function NodexDropdownSummarySubmenuItem({
  ariaLabel,
  label,
  value,
  children,
  className,
  disabled = false,
  contentClassName,
  tooltipText,
  onOpenChange,
}: {
  ariaLabel?: string;
  label: ReactNode;
  value: ReactNode;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  contentClassName?: string;
  tooltipText?: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <NodexDropdownFlyoutSubmenuItem
      ariaLabel={ariaLabel}
      label={label}
      disabled={disabled}
      className={className}
      contentClassName={contentClassName}
      tooltipText={tooltipText}
      onOpenChange={onOpenChange}
      triggerContent={
        <div className="flex w-full min-w-0 items-center gap-3">
          <span className="shrink-0">{label}</span>
          <span className="flex min-w-0 flex-1 justify-end text-token-text-tertiary">
            <span className="min-w-0 truncate">{value}</span>
          </span>
          <ChevronRightIcon className="icon-xs shrink-0 text-token-input-placeholder-foreground" />
        </div>
      }
    >
      {children}
    </NodexDropdownFlyoutSubmenuItem>
  );
}

export function NodexDropdownSelectedIcon({ className }: { className?: string } = {}) {
  return (
    <CheckmarkIcon
      className={cn(
        "icon-xs shrink-0 text-token-foreground opacity-75 group-focus:opacity-100 group-hover:opacity-100",
        className,
      )}
    />
  );
}

export const NodexDropdown = {
  Menu: NodexDropdownMenu,
  Content: NodexDropdownContent,
  ButtonTrigger: NodexDropdownButtonTrigger,
  SettingsTrigger: NodexSettingsDropdownTrigger,
  Item: NodexDropdownItem,
  RadioGroup: NodexDropdownRadioGroup,
  RadioItem: NodexDropdownRadioItem,
  Input: NodexDropdownInput,
  SearchInput: NodexDropdownSearchInput,
  Separator: NodexDropdownSeparator,
  Surface: NodexDropdownSurface,
  ScrollList: NodexDropdownScrollList,
  ActionRow: NodexDropdownActionRow,
  Section: NodexDropdownSection,
  SectionLabel: NodexDropdownSectionLabel,
  Message: NodexDropdownMessage,
  Title: NodexDropdownTitle,
  FlyoutSubmenuItem: NodexDropdownFlyoutSubmenuItem,
  SummarySubmenuItem: NodexDropdownSummarySubmenuItem,
  SelectedIcon: NodexDropdownSelectedIcon,
};
