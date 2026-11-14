import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { ChevronDownIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";

/**
 * Every Property line shares three vertical edges, measured from the Page's content edge, where
 * its title and body start: icons sit on that edge, labels 24px in, and values 136px in. Ink and
 * visible chrome (text, glyphs, chip outlines) meet their edge; hover and focus surfaces hang
 * 6px outside it, into the gutter the value cell declares.
 */
const PROPERTY_ROW_GRID_CLASS_NAME =
  "grid min-h-7.5 grid-cols-[8rem_minmax(0,1fr)] items-start [--page-property-value-gutter:0.375rem]";

/** The icon column: a glyph in a 16px box on the content edge. */
export const pageStagePropertyIconSlot =
  "flex size-4 shrink-0 items-center justify-center text-(--foreground-tertiary) [&_svg]:size-4";

/** A pressable icon + label lead whose hover surface hangs outside the content edge. */
export const pageStagePropertyLeadButton =
  "-ml-1.5 flex min-w-0 cursor-interaction items-center gap-2 rounded-sm pr-2 pl-1.5 text-sm/5 hover:bg-token-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-token-focus-border";

export interface PageStagePropertyDisclosure {
  readonly expanded: boolean;
  /** The element the label folds and unfolds. */
  readonly controls: string;
  readonly onToggle: () => void;
}

/** The one label | value grammar shared by Source Properties and Page capabilities. */
export function PageStagePropertyRow({
  icon,
  label,
  disclosure,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  /** Makes the label fold and unfold a value that spans several lines. */
  readonly disclosure?: PageStagePropertyDisclosure;
  readonly children: ReactNode;
}) {
  const lead = (
    <>
      <span className={pageStagePropertyIconSlot}>{icon}</span>
      <span className="min-w-0 truncate text-sm/5 text-(--foreground-secondary)">{label}</span>
    </>
  );
  return (
    <div {...rowProps} className={cn(PROPERTY_ROW_GRID_CLASS_NAME, className)}>
      <div className="flex min-h-7.5 min-w-0 items-center gap-2 pr-2">
        {disclosure ? (
          <button
            type="button"
            aria-expanded={disclosure.expanded}
            aria-controls={disclosure.controls}
            onClick={disclosure.onToggle}
            className={cn(pageStagePropertyLeadButton, "h-6 pr-1")}
          >
            {lead}
            <ChevronDownIcon
              className={cn(
                "icon-2xs -ml-1 shrink-0 text-(--foreground-tertiary) transition-transform duration-150",
                !disclosure.expanded && "-rotate-90",
              )}
            />
          </button>
        ) : (
          lead
        )}
      </div>
      <div className="flex min-h-7.5 min-w-0 items-center pl-2">{children}</div>
    </div>
  );
}
