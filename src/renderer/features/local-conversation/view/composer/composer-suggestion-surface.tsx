import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

const COMPOSER_TOP_MENU_CHROME_HEIGHT_PX = 46;
const COMPOSER_TOP_MENU_VIEWPORT_GAP_PX = 8;
const COMPOSER_TOP_MENU_MAX_HEIGHT_PROPERTY = "--composer-top-menu-max-height";

export function calculateComposerHomeMenuMaxHeight(input: {
  readonly anchorBottomPx: number;
  readonly windowZoom: number;
}): number {
  const zoom = Number.isFinite(input.windowZoom) && input.windowZoom > 0 ? input.windowZoom : 1;
  return Math.max(
    0,
    Math.floor(
      input.anchorBottomPx / zoom -
        COMPOSER_TOP_MENU_CHROME_HEIGHT_PX -
        COMPOSER_TOP_MENU_VIEWPORT_GAP_PX,
    ),
  );
}

function readComposerWindowZoom(element: HTMLElement): number {
  const value = Number.parseFloat(
    window.getComputedStyle(element).getPropertyValue("--codex-window-zoom"),
  );
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export const ComposerSuggestionRow = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
    readonly highlighted: boolean;
    readonly onHighlight?: () => void;
  }
>(function ComposerSuggestionRow(
  { highlighted, onHighlight, className, onMouseDown, onMouseMove, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-selected={highlighted}
      data-list-navigation-item="true"
      className={cn(
        "text-token-foreground outline-hidden opacity-75 focus:bg-token-list-hover-background cursor-interaction w-full shrink-0 overflow-hidden rounded-lg px-row-x py-row-y text-left text-sm",
        highlighted && "bg-token-list-hover-background opacity-100",
        className,
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown?.(event);
      }}
      onMouseMove={(event) => {
        onHighlight?.();
        onMouseMove?.(event);
      }}
    />
  );
});

export function ComposerSuggestionSurface({
  kind,
  ariaLabel,
  isHomeMenu = false,
  maxHeightClassName,
  className,
  children,
}: {
  readonly kind: "add-context" | "skill-mention" | "slash-command";
  readonly ariaLabel?: string;
  readonly isHomeMenu?: boolean;
  readonly maxHeightClassName?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!isHomeMenu || !element) return;

    let animationFrame: number | null = null;
    let previousValue = "";
    const update = () => {
      const maxHeight = calculateComposerHomeMenuMaxHeight({
        anchorBottomPx: element.getBoundingClientRect().bottom,
        windowZoom: readComposerWindowZoom(element),
      });
      const value = `${maxHeight}px`;
      if (value === previousValue) return;
      previousValue = value;
      element.style.setProperty(COMPOSER_TOP_MENU_MAX_HEIGHT_PROPERTY, value);
    };
    const scheduleUpdate = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        update();
      });
    };

    update();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(element);
    observer?.observe(document.documentElement);

    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      observer?.disconnect();
      element.style.removeProperty(COMPOSER_TOP_MENU_MAX_HEIGHT_PROPERTY);
    };
  }, [isHomeMenu]);

  return (
    <div
      data-composer-overlay-floating-ui="true"
      className="absolute right-0 bottom-full left-0 z-50 mb-2"
    >
      <div
        ref={surfaceRef}
        data-composer-suggestion-menu="true"
        data-composer-home-top-menu={isHomeMenu ? "true" : undefined}
        data-add-context-menu={kind === "add-context" ? "true" : undefined}
        data-skill-mention-menu={kind === "skill-mention" ? "true" : undefined}
        data-slash-command-menu={kind === "slash-command" ? "true" : undefined}
        aria-label={ariaLabel}
        className={cn(
          "border-token-border bg-token-dropdown-background/90 relative flex w-full flex-col overflow-hidden rounded-2xl border p-1 text-sm backdrop-blur-sm",
          isHomeMenu
            ? "max-h-[min(320px,var(--composer-top-menu-max-height,320px))]"
            : (maxHeightClassName ?? "max-h-[320px]"),
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
