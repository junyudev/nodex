import {
  arrow,
  autoUpdate,
  flip,
  FloatingArrow,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useFloating,
  type Placement,
} from "@floating-ui/react";
import { useId, useState, type ReactNode } from "react";
import { CloseIcon } from "@/components/shared/icons";
import { NodexFloatingSurface } from "./floating-surface";
import { ShortcutKeycaps } from "./shortcut-keycaps";

const ARROW_WIDTH = 14;
const ARROW_HEIGHT = 7;
/** How far the arrow keeps from the card's corner, which a start or end card leans its edge by. */
const ARROW_INSET = 12;
const COLLISION_PADDING = 8;

export interface NodexCoachmarkProps {
  /** The control it points at, which keeps doing what it always does. */
  readonly anchor: HTMLElement | null;
  readonly open: boolean;
  /** The control's name, as its tooltip says it. */
  readonly title: string;
  /** The control's shortcut, as its tooltip says it. */
  readonly shortcutLabel?: string;
  /** What the control is for, in one sentence. */
  readonly description: ReactNode;
  readonly dismissLabel: string;
  readonly onDismiss: () => void;
  readonly placement?: Placement;
}

/**
 * A tip beside the control it introduces: the control's name and shortcut, as its tooltip says
 * them, then what it is for. It stays until the person puts it away or uses the control, so it
 * claims nothing a passing layer does: not Escape, not a click elsewhere, not focus. Escape and
 * clicks keep meaning what they meant, and tabbing from the control reaches its `×`.
 */
export function NodexCoachmark({
  anchor,
  open,
  title,
  shortcutLabel,
  description,
  dismissLabel,
  onDismiss,
  placement = "bottom",
}: NodexCoachmarkProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [arrowElement, setArrowElement] = useState<SVGSVGElement | null>(null);
  const shown = open && anchor !== null;
  const {
    context,
    floatingStyles,
    placement: resolvedPlacement,
    refs: { setFloating },
  } = useFloating<HTMLElement>({
    open: shown,
    placement,
    elements: { reference: anchor },
    // Positioned by offsets, so its entrance can move it without fighting its place.
    transform: false,
    middleware: [
      // A card set to a control's start or end lines its arrow up with a small control's center.
      offset(({ placement: current, rects }) => ({
        mainAxis: ARROW_HEIGHT,
        alignmentAxis: current.includes("-")
          ? Math.min(0, rects.reference.width / 2 - ARROW_INSET - ARROW_WIDTH / 2)
          : 0,
      })),
      flip({ padding: COLLISION_PADDING }),
      shift({ padding: COLLISION_PADDING }),
      arrow({ element: arrowElement, padding: ARROW_INSET }),
    ],
    whileElementsMounted: autoUpdate,
  });
  if (!shown) return null;
  const side = resolvedPlacement.split("-")[0];
  return (
    <FloatingPortal preserveTabOrder>
      <FloatingFocusManager
        context={context}
        modal={false}
        initialFocus={-1}
        returnFocus={false}
        closeOnFocusOut={false}
      >
        <NodexFloatingSurface
          ref={setFloating}
          role="dialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-slot="coachmark"
          data-side={side}
          className="w-64 gap-1 bg-token-dropdown-background px-3 pt-2 pb-2.5 backdrop-blur-none animate-in duration-300 ease-[cubic-bezier(.23,1,.32,1)] fade-in-0 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 motion-reduce:animate-none"
          style={floatingStyles}
        >
          <div className="flex min-h-6 items-center gap-2">
            <span id={titleId} className="min-w-0 truncate font-medium">
              {title}
            </span>
            {shortcutLabel ? <ShortcutKeycaps keys={[shortcutLabel]} density="compact" /> : null}
            <button
              type="button"
              aria-label={dismissLabel}
              className="-me-1 ms-auto flex size-5 shrink-0 cursor-interaction items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/[0.07] hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-token-focus-border"
              onClick={onDismiss}
            >
              <CloseIcon className="icon-2xs" />
            </button>
          </div>
          <p id={descriptionId} className="text-token-text-secondary">
            {description}
          </p>
          <FloatingArrow
            ref={setArrowElement}
            context={context}
            width={ARROW_WIDTH}
            height={ARROW_HEIGHT}
            tipRadius={2}
            fill="var(--color-token-dropdown-background)"
            stroke="var(--color-token-border)"
            strokeWidth={0.5}
          />
        </NodexFloatingSurface>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
