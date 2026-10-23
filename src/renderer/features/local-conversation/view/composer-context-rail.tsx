import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useFloatingComposerHeaderSlot } from "@/features/floating-composer/floating-composer-header-slot";

interface ComposerContextRailSlotProps {
  visible: boolean;
  children: ReactNode;
}

interface ComposerContextRailProps {
  children: ReactNode;
  className?: string;
}

export function ComposerContextRailSlot({ visible, children }: ComposerContextRailSlotProps) {
  const floatingHeader = useFloatingComposerHeaderSlot();
  if (!visible) return null;
  // A floating composer hosts the rail in its own header row.
  if (floatingHeader) return children;

  return (
    <div data-composer-external-footer-slot="true" className="relative z-0 -mb-2">
      {children}
    </div>
  );
}

export function ComposerContextRail({ children, className }: ComposerContextRailProps) {
  const floatingHeader = useFloatingComposerHeaderSlot();
  if (floatingHeader) {
    return createPortal(
      <div
        data-composer-lower-status-row="true"
        data-composer-context-rail="true"
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden select-none"
      >
        {children}
      </div>,
      floatingHeader,
    );
  }

  return (
    <div
      data-composer-lower-status-row="true"
      data-composer-context-rail="true"
      className={cn(
        "relative mx-[var(--right-panel-composer-accessory-inline-inset,13px)] -mb-[calc(var(--radius-2xl)+4px)] flex min-w-0 flex-nowrap items-center gap-2 overflow-clip rounded-t-2xl bg-background-composer-action-bar px-1 pt-[5px] pb-[calc(var(--radius-2xl)+9px)] select-none supports-[corner-shape:superellipse(1.5)]:[corner-shape:var(--codex-corner-shape)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
