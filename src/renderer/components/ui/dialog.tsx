import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { CloseIcon } from "@/components/shared/icons";
import { APP_SHELL_MODAL_LAYER_CLASS, APP_SHELL_MODAL_LAYER_INDEX } from "@/lib/app-shell-layers";
import { cn } from "@/lib/utils";
import { NodexFloatingLayerProvider, useNodexFloatingLayerIndex } from "./floating-layer";
import { hasOpenNodexFloatingEscapeLayer } from "./floating-surface";

export type NodexDialogSize = "narrow" | "compact" | "default" | "wide" | "large";

const NODEX_DIALOG_SIZE_CLASS: Record<NodexDialogSize, string> = {
  narrow: "w-[380px]",
  compact: "w-[420px]",
  default: "w-[520px]",
  wide: "w-[576px]",
  large: "w-[768px]",
};

const NODEX_DIALOG_ACTION_STYLES = {
  danger: [
    "bg-token-charts-red/10 text-token-charts-red",
    "enabled:hover:bg-token-charts-red/20 enabled:active:bg-token-charts-red/30",
  ],
  ghost: [
    "text-token-text-tertiary",
    "enabled:hover:bg-token-list-hover-background enabled:active:bg-token-foreground/15",
    "data-[state=open]:bg-token-list-hover-background",
  ],
  primary: [
    "bg-token-foreground text-token-dropdown-background",
    "enabled:hover:bg-token-foreground/80 enabled:active:bg-token-foreground/70",
    "data-[state=open]:bg-token-foreground/80",
  ],
} as const;

export type NodexDialogDismissReason =
  | "trigger"
  | "outside"
  | "escape"
  | "close"
  | "focus-out"
  | "imperative"
  | "none";

export interface NodexDialogOpenChangeDetails {
  reason: NodexDialogDismissReason;
  cancel: () => void;
}

export interface NodexDialogProps {
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  modal?: boolean | "trap-focus";
  disablePointerDismissal?: boolean;
  onOpenChange?: (open: boolean, details: NodexDialogOpenChangeDetails) => void;
  onOpenChangeComplete?: (open: boolean) => void;
}

function toNodexDialogDismissReason(
  reason: DialogPrimitive.Root.ChangeEventReason,
): NodexDialogDismissReason {
  switch (reason) {
    case "trigger-press":
      return "trigger";
    case "outside-press":
      return "outside";
    case "escape-key":
      return "escape";
    case "close-press":
      return "close";
    case "focus-out":
      return "focus-out";
    case "imperative-action":
      return "imperative";
    case "none":
      return "none";
  }
}

export function NodexDialog({ onOpenChange, ...props }: NodexDialogProps) {
  return (
    <DialogPrimitive.Root
      {...props}
      onOpenChange={(open, details) => {
        if (
          !open &&
          details.reason === "escape-key" &&
          hasOpenNodexFloatingEscapeLayer(details.event.view?.document ?? document)
        ) {
          details.cancel();
          return;
        }
        onOpenChange?.(open, {
          reason: toNodexDialogDismissReason(details.reason),
          cancel: details.cancel,
        });
      }}
    />
  );
}

export function NodexDialogTrigger({
  children,
  ...props
}: Omit<DialogPrimitive.Trigger.Props, "render" | "children"> & {
  children: React.ReactNode;
}) {
  if (!React.isValidElement(children)) {
    throw new Error("NodexDialogTrigger requires one concrete interactive child");
  }
  return <DialogPrimitive.Trigger data-slot="codex-dialog-trigger" render={children} {...props} />;
}

export function NodexDialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="codex-dialog-portal" {...props} />;
}

export function NodexDialogClose({
  children,
  ...props
}: Omit<DialogPrimitive.Close.Props, "render" | "children"> & {
  children: React.ReactNode;
}) {
  if (!React.isValidElement(children)) {
    throw new Error("NodexDialogClose requires one concrete interactive child");
  }
  return <DialogPrimitive.Close data-slot="codex-dialog-close" render={children} {...props} />;
}

export function NodexDialogOverlay({ className, style, ...props }: DialogPrimitive.Backdrop.Props) {
  const layerIndex = useNodexFloatingLayerIndex(undefined, APP_SHELL_MODAL_LAYER_INDEX);
  const layeredStyle =
    typeof style === "function"
      ? (state: DialogPrimitive.Backdrop.State) => ({ ...style(state), zIndex: layerIndex })
      : { ...style, zIndex: layerIndex };

  return (
    <DialogPrimitive.Backdrop
      {...props}
      data-slot="codex-dialog-overlay"
      className={cn(
        "codex-dialog-overlay fixed inset-0 bg-[#00000022]",
        APP_SHELL_MODAL_LAYER_CLASS,
        className,
      )}
      style={layeredStyle}
    />
  );
}

export function NodexDialogContent({
  className,
  overlayClassName,
  children,
  showCloseButton = true,
  closeButtonAriaLabel = "Close",
  closeButtonClassName,
  closeIconClassName,
  size = "default",
  unstyledContent = false,
  style,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  overlayClassName?: string;
  closeButtonAriaLabel?: string;
  closeButtonClassName?: string;
  closeIconClassName?: string;
  size?: NodexDialogSize;
  unstyledContent?: boolean;
}) {
  const layerIndex = useNodexFloatingLayerIndex(undefined, APP_SHELL_MODAL_LAYER_INDEX);
  const layeredStyle =
    typeof style === "function"
      ? (state: DialogPrimitive.Popup.State) => ({ ...style(state), zIndex: layerIndex })
      : { ...style, zIndex: layerIndex };

  return (
    <NodexDialogPortal>
      <NodexDialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        data-slot="codex-dialog-content"
        className={cn(
          "codex-dialog fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 outline-none",
          APP_SHELL_MODAL_LAYER_CLASS,
          !unstyledContent && [
            "max-w-[92vw] rounded-3xl bg-token-dropdown-background/90 text-token-foreground",
            "shadow-[0px_4px_8px_-2px_#0000001a] ring-[0.5px] ring-token-border backdrop-blur-xl",
            "overflow-hidden",
            NODEX_DIALOG_SIZE_CLASS[size],
          ],
          className,
        )}
        style={layeredStyle}
        {...props}
        data-nodex-keyboard-scope="local"
      >
        <NodexFloatingLayerProvider zIndex={layerIndex}>
          {children}
          {showCloseButton ? (
            <DialogPrimitive.Close
              className={cn(
                "no-drag absolute top-4 right-4 cursor-interaction rounded p-1 leading-none text-token-foreground/80 hover:bg-token-toolbar-hover-background focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border",
                closeButtonClassName,
              )}
              aria-label={closeButtonAriaLabel}
            >
              <CloseIcon className={closeIconClassName ?? "icon-xs"} />
            </DialogPrimitive.Close>
          ) : null}
        </NodexFloatingLayerProvider>
      </DialogPrimitive.Popup>
    </NodexDialogPortal>
  );
}

const NODEX_DIALOG_FRAME_CLASS =
  "flex flex-col gap-0 px-5 py-5 text-base leading-normal tracking-normal [--text-heading-md:21px] [font-weight:445]";

export function NodexDialogFrame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="codex-dialog-frame"
      className={cn(NODEX_DIALOG_FRAME_CLASS, className)}
      {...props}
    />
  );
}

export function NodexDialogForm({ className, ...props }: React.ComponentProps<"form">) {
  return (
    <form
      data-slot="codex-dialog-form"
      className={cn(NODEX_DIALOG_FRAME_CLASS, className)}
      {...props}
    />
  );
}

export function NodexDialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="codex-dialog-body"
      className={cn("flex w-full flex-col pt-3 first:pt-0", className)}
      {...props}
    />
  );
}

export function NodexDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <NodexDialogBody>
      <div className="flex flex-col items-start gap-3">
        <div
          data-slot="codex-dialog-header"
          className={cn("flex min-w-0 flex-1 flex-col gap-1 self-stretch", className)}
          {...props}
        />
      </div>
    </NodexDialogBody>
  );
}

export function NodexDialogFooter({
  className,
  bodyClassName,
  ...props
}: React.ComponentProps<"div"> & {
  bodyClassName?: string;
}) {
  return (
    <NodexDialogBody className={bodyClassName}>
      <div
        data-slot="codex-dialog-footer"
        className={cn("flex w-full items-center justify-end gap-3", className)}
        {...props}
      />
    </NodexDialogBody>
  );
}

export function NodexDialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="codex-dialog-title"
      className={cn("heading-dialog min-w-0 font-semibold text-token-foreground", className)}
      {...props}
    />
  );
}

export function NodexDialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="codex-dialog-description"
      className={cn(
        "text-base leading-normal tracking-normal text-token-description-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function NodexDialogAction({
  className,
  tone = "ghost",
  size = "default",
  type = "button",
  ...props
}: React.ComponentProps<"button"> & {
  tone?: keyof typeof NODEX_DIALOG_ACTION_STYLES;
  size?: "default" | "compact";
}) {
  return (
    <button
      data-slot="codex-dialog-action"
      type={type}
      className={cn(
        "no-drag flex cursor-interaction items-center gap-1 whitespace-nowrap border border-transparent select-none",
        size === "compact"
          ? "h-7 rounded-full px-2.5 py-0 text-xs font-medium leading-3"
          : "rounded-lg px-4 py-1.5 text-base leading-[18px]",
        "focus:outline-none disabled:cursor-not-allowed disabled:opacity-40",
        NODEX_DIALOG_ACTION_STYLES[tone],
        className,
      )}
      {...props}
    />
  );
}
