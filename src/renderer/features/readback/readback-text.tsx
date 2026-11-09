import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { cn } from "@/lib/utils";

const COMPACT_MARKDOWN_STYLE = {
  "--markdown-font-size": "13px",
  "--markdown-line-height": "20px",
} as CSSProperties;

const MODE_CLASS = {
  /** Five lines, fading out when there is more. */
  clamped: "max-h-[100px] overflow-hidden",
  /** All of it, scrolling past half the window. */
  expanded: "max-h-[min(50vh,28rem)] overflow-y-auto",
  /** Six lines that scroll, for surfaces that cannot grow. */
  scroll: "max-h-[120px] overflow-y-auto",
} as const;

/** True when clamped text is cut off, so the fade appears only when there is more to read. */
function useClampedOverflow(clamped: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !clamped) return;
    // The clamp keeps its height while the text inside grows, so both are observed. Observing
    // reports the first size too, so nothing is measured during the effect itself.
    const observer = new ResizeObserver(() =>
      setOverflowing(element.scrollHeight > element.clientHeight + 1),
    );
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [clamped]);
  return { ref, overflowing: clamped && overflowing };
}

/** An agent's opening statement in compact conversation Markdown. */
export function ReadbackText({
  text,
  mode,
  className,
  onClick,
}: {
  text: string;
  mode: keyof typeof MODE_CLASS;
  className?: string;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const { ref, overflowing } = useClampedOverflow(mode === "clamped");
  return (
    // A larger pointer target for an action the surface also offers as a button.
    <div
      ref={ref}
      data-readback-text=""
      className={cn(
        "text-token-foreground",
        MODE_CLASS[mode],
        overflowing && "[mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]",
        className,
      )}
      onClick={onClick}
    >
      <MarkdownRenderer
        content={text}
        dialect="conversation"
        preserveLineBreaks
        style={COMPACT_MARKDOWN_STYLE}
      />
    </div>
  );
}
