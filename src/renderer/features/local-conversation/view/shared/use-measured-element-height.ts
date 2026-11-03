import { useCallback, useState } from "react";

export function useMeasuredElementHeight() {
  const [elementHeightPx, setElementHeightPx] = useState(0);
  const elementRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      setElementHeightPx(0);
      return;
    }
    const updateHeight = () => {
      const nextHeight = node.scrollHeight;
      setElementHeightPx((current) => (current === nextHeight ? current : nextHeight));
    };
    updateHeight();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateHeight);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      setElementHeightPx(0);
    };
  }, []);
  return { elementHeightPx, elementRef };
}
