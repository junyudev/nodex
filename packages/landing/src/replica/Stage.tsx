import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Renders a replica at its designed pixel size and scales it to the space it is given, so the
 * product UI keeps its real proportions on every screen. Below `compactBelow` the caller can
 * render a cropped, larger layout instead of a miniature of the whole window.
 */
export function Stage({
  width,
  height,
  compactWidth,
  compactHeight,
  compactBelow = 720,
  children,
}: {
  readonly width: number;
  readonly height: number;
  readonly compactWidth?: number;
  readonly compactHeight?: number;
  readonly compactBelow?: number;
  readonly children: (layout: { readonly compact: boolean }) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const compact = available !== null && compactWidth !== undefined && available < compactBelow;
  const designWidth = compact ? compactWidth! : width;
  const designHeight = compact ? (compactHeight ?? height) : height;
  const scale = available === null ? 1 : Math.min(1, available / designWidth);

  // Nothing is drawn until the width is known: a full-size window would otherwise widen a
  // phone's page before the first measurement.
  return (
    <div ref={ref} className="relative w-full" style={{ height: designHeight * scale }}>
      {available === null ? null : (
        <div
          className="absolute top-0 left-1/2 origin-top"
          style={{
            width: designWidth,
            height: designHeight,
            transform: `translateX(-50%) scale(${scale})`,
          }}
        >
          {children({ compact })}
        </div>
      )}
    </div>
  );
}
