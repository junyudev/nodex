import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { cursorTargetPoint, type Point } from "./cursor-target";

export type { Point } from "./cursor-target";

/**
 * Resolves a target in window-local pixels. A stable lane edge can anticipate its landing row
 * while the element is still moving.
 */
export function useCursorTarget(
  target: string | null,
  bottomAnchor?: string,
): {
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
    // Track size and scale changes; an anchored row stays at its destination throughout reflow.
    const measure = () => {
      const element = root.querySelector<HTMLElement>(`[data-cursor-target="${target}"]`);
      // A target this layout doesn't draw (such as the sidebar on a phone) hides the pointer
      // instead of leaving it to click wherever it last was.
      if (!element) setPoint(null);
      if (element) {
        const box = root.getBoundingClientRect();
        const scale = box.width / root.offsetWidth || 1;
        const rect = element.getBoundingClientRect();
        const bottom = bottomAnchor
          ? root
              .querySelector<HTMLElement>(`[data-cursor-anchor="${bottomAnchor}"]`)
              ?.getBoundingClientRect().bottom
          : undefined;
        const next = cursorTargetPoint({ x: box.left, y: box.top }, rect, scale, bottom);
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
  }, [target, bottomAnchor]);

  return { ref, point };
}

/** A macOS pointer that glides to its target and dips when it clicks. */
export function Cursor({
  target,
  pressed,
  hold = false,
  bottomAnchor,
  rest,
}: {
  /** The `data-cursor-target` to point at; null hides it unless held. */
  readonly target: string | null;
  readonly pressed: boolean;
  /** Keep the last position visible between actions. */
  readonly hold?: boolean;
  /** Predict the target's resting row from this stable `data-cursor-anchor` bottom edge. */
  readonly bottomAnchor?: string;
  /** Where the pointer first enters from. Hidden pointers keep their last measured position. */
  readonly rest: Point;
}) {
  const { ref, point } = useCursorTarget(target, bottomAnchor);
  const movement = bottomAnchor
    ? ({ duration: 0.3, ease: [0.16, 1, 0.3, 1] } as const)
    : ({ type: "spring", stiffness: 170, damping: 24 } as const);
  const visible = (target !== null || hold) && point !== null;
  const at = point ?? rest;
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-20">
      <motion.svg
        viewBox="0 0 20 24"
        className="absolute top-0 left-0 h-[22px] w-[18px] drop-shadow-[0_2px_3px_rgb(0_0_0/0.45)]"
        initial={false}
        animate={{ x: at.x, y: at.y, opacity: visible ? 1 : 0, scale: pressed ? 0.85 : 1 }}
        transition={{
          x: movement,
          y: movement,
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
