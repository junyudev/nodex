import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Finds where a `data-cursor-target` element sits inside the demo's window, in the window's own
 * unscaled pixels, and keeps following it while it is the target.
 */
export function useCursorTarget(target: string | null): {
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly point: Point | null;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [point, setPoint] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const anchor = ref.current;
    const root = anchor?.closest<HTMLElement>("[data-app-window]");
    if (!target || !root) return;
    let frame = 0;
    // Follow the target every frame until it changes: the element it names can still be
    // settling from a layout animation, such as a card sliding into the place of one that left.
    const measure = () => {
      const element = root.querySelector<HTMLElement>(`[data-cursor-target="${target}"]`);
      // A target this layout doesn't draw (such as the sidebar on a phone) hides the pointer
      // instead of leaving it to click wherever it last was.
      if (!element) setPoint(null);
      if (element) {
        const box = root.getBoundingClientRect();
        const scale = box.width / root.offsetWidth || 1;
        const rect = element.getBoundingClientRect();
        const next = {
          x: (rect.left - box.left + rect.width * 0.42) / scale,
          y: (rect.top - box.top + rect.height * 0.55) / scale,
        };
        setPoint((current) =>
          current && Math.abs(current.x - next.x) < 0.5 && Math.abs(current.y - next.y) < 0.5
            ? current
            : next,
        );
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return { ref, point };
}

/** A macOS pointer that glides to its target and dips when it clicks. */
export function Cursor({
  target,
  pressed,
  rest,
}: {
  /** The `data-cursor-target` to point at; null hides the pointer. */
  readonly target: string | null;
  readonly pressed: boolean;
  /** Where the pointer enters from and leaves to. */
  readonly rest: Point;
}) {
  const { ref, point } = useCursorTarget(target);
  const visible = target !== null && point !== null;
  const at = visible ? point : rest;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-20">
      <motion.svg
        viewBox="0 0 20 24"
        className="absolute top-0 left-0 h-[22px] w-[18px] drop-shadow-[0_2px_3px_rgb(0_0_0/0.45)]"
        initial={false}
        animate={{ x: at.x, y: at.y, opacity: visible ? 1 : 0, scale: pressed ? 0.85 : 1 }}
        transition={{
          x: { type: "spring", stiffness: 170, damping: 24 },
          y: { type: "spring", stiffness: 170, damping: 24 },
          opacity: { duration: 0.25 },
          scale: { duration: 0.1 },
        }}
      >
        <path
          d="M2 1.5v18.2l4.7-4.4 3 6.8 3.1-1.4-3-6.6h6.6L2 1.5Z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </motion.svg>
    </div>
  );
}
