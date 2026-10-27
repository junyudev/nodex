import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ChevronDownMdIcon } from "@/components/shared/icons/customize-action-icons";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { sanitizePluginDescription } from "../model/plugin-detail-model";

const COLLAPSED_CLASS = "line-clamp-[15]";
const EASE = [0.22, 1, 0.36, 1] as const;
const MARKDOWN_STYLE = { "--markdown-font-size": "var(--text-sm)" } as CSSProperties;

interface Heights {
  readonly full: number;
  readonly collapsed: number;
}

/** Measures the content with and without the 15-line clamp, without a visible flash. */
function measure(element: HTMLElement): Heights {
  element.classList.add(COLLAPSED_CLASS);
  const collapsed = element.getBoundingClientRect().height;
  element.classList.remove(COLLAPSED_CLASS);
  return { full: element.getBoundingClientRect().height, collapsed };
}

/**
 * A plugin's long description as Markdown, folded to its first 15 lines behind a fade with a
 * "Show more" toggle. Content below the fold stays out of the tab order while folded.
 */
export function PluginDescription({
  markdown,
  onTransitionChange,
}: {
  readonly markdown: string;
  /** Lets the page pause scroll anchoring while the height animates. */
  readonly onTransitionChange?: (transitioning: boolean) => void;
}) {
  const id = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<Heights | null>(null);
  const clampable = heights != null && heights.full > heights.collapsed + 0.5;
  const folded = clampable && !expanded;

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element == null) return;
    const update = () => {
      const next = measure(element);
      setHeights((current) =>
        current?.full === next.full && current.collapsed === next.collapsed ? current : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element == null || heights == null) return;
    for (const node of element.querySelectorAll<HTMLElement>("a, p, li, td, th, pre")) {
      node.inert = folded && node.offsetTop + node.offsetHeight > heights.collapsed;
    }
  }, [folded, heights]);

  const heightDuration = expanded ? 0.18 : 0.16;
  const height = heights == null ? "auto" : folded ? heights.collapsed : heights.full;

  return (
    <div>
      <motion.div
        id={id}
        className="overflow-clip [mask-image:linear-gradient(to_bottom,black_calc(100%-4rem),rgb(0_0_0/var(--description-fade,1)))]"
        initial={false}
        animate={{ height, "--description-fade": folded ? 0 : 1 }}
        transition={{
          duration: reducedMotion ? 0 : heightDuration,
          ease: EASE,
          "--description-fade": { duration: reducedMotion ? 0 : expanded ? 0.09 : 0.16 },
        }}
        onAnimationComplete={() => onTransitionChange?.(false)}
      >
        <div ref={contentRef} className={heights == null ? COLLAPSED_CLASS : undefined}>
          <MarkdownRenderer
            content={sanitizePluginDescription(markdown)}
            preserveLineBreaks
            style={MARKDOWN_STYLE}
            className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
      </motion.div>
      {clampable ? (
        <button
          type="button"
          aria-controls={id}
          aria-expanded={expanded}
          className="mt-4 flex cursor-interaction scroll-my-4 items-center gap-1 text-sm text-(--color-text-secondary) select-none hover:underline"
          onClick={() => {
            onTransitionChange?.(true);
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : "Show more"}
          <motion.span
            aria-hidden
            initial={false}
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: reducedMotion ? 0 : heightDuration, ease: EASE }}
          >
            <ChevronDownMdIcon />
          </motion.span>
        </button>
      ) : null}
    </div>
  );
}
