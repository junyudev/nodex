import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useFloatingComposerHeaderSlot } from "@/features/floating-composer/floating-composer-header-slot";

/**
 * A tab attached above a docked composer: its lower edge tucks under the composer's top edge, so
 * the composer seems to rest on it. The context rail and the composer notice share it.
 */
export const COMPOSER_ATTACHED_TAB_CLASS =
  "mx-[var(--right-panel-composer-accessory-inline-inset,13px)] -mb-[calc(var(--radius-2xl)+4px)] overflow-clip rounded-t-2xl pt-[5px] pb-[calc(var(--radius-2xl)+9px)] supports-[corner-shape:superellipse(1.5)]:[corner-shape:var(--codex-corner-shape)]";

/** Holds attached tabs behind the composer, which overlaps their lower edge. */
export function ComposerAttachedTabSlot({
  children,
  ...attributes
}: { children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <div {...attributes} className="relative z-0 -mb-2">
      {children}
    </div>
  );
}

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
    <ComposerAttachedTabSlot data-composer-external-footer-slot="true">
      {children}
    </ComposerAttachedTabSlot>
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
        COMPOSER_ATTACHED_TAB_CLASS,
        "relative flex min-w-0 flex-nowrap items-center gap-2 bg-background-composer-action-bar px-1 select-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
