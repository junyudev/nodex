import { Tooltip as RadixTooltip } from "radix-ui";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface TooltipProps {
  children: ReactNode;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  contentClassName?: string;
  delayDuration?: number;
  disableAnimation?: boolean;
  enableHoverableContent?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={150} skipDelayDuration={150}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({
  children,
  content,
  side = "bottom",
  sideOffset = 6,
  contentClassName,
  delayDuration,
  disableAnimation = false,
  enableHoverableContent,
  onOpenChange,
}: TooltipProps) {
  return (
    <RadixTooltip.Root
      delayDuration={delayDuration}
      disableHoverableContent={!enableHoverableContent}
      onOpenChange={onOpenChange}
    >
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={sideOffset}
          collisionPadding={8}
          className={cn(
            "z-50 rounded-xl border px-2 py-1 text-sm",
            "border-[color-mix(in_srgb,var(--border)_85%,transparent)]",
            "bg-[color-mix(in_srgb,var(--background-secondary)_96%,transparent)] text-(--foreground)",
            "shadow-[0_12px_30px_rgba(0,0,0,0.22)] backdrop-blur-md",
            "outline-none",
            disableAnimation
              ? "animate-none transition-none"
              : "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-[0.985] data-[side=bottom]:data-[state=delayed-open]:slide-in-from-top-1 data-[side=left]:data-[state=delayed-open]:slide-in-from-right-1 data-[side=right]:data-[state=delayed-open]:slide-in-from-left-1 data-[side=top]:data-[state=delayed-open]:slide-in-from-bottom-1",
            contentClassName,
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
