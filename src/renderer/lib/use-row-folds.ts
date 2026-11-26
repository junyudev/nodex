import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * How many of a toolbar row's folds it needs before its content fits, folding in order.
 *
 * A fold is a presence attribute on the row, `data-<fold>`, that the row's CSS answers, such as
 * gathering its tools into a menu or showing its views by their glyphs alone. Every fold is tried
 * in order before the frame paints, so the row never overflows while a denser layout would fit,
 * and never folds while a roomier one fits. `region` is the one part of the row that yields
 * space; when even the last fold leaves its content wider than it, the region scrolls.
 *
 * The row measures again when it resizes, when its content changes, such as a count gaining a
 * digit, and after each render of its owner, which can change what the row holds without either,
 * such as which of its views is current. Content is watched as mutations rather than sizes, so
 * folding never resizes what is observed and the row settles in one pass.
 */
export function useRowFolds(
  row: RefObject<HTMLElement | null>,
  region: RefObject<HTMLElement | null>,
  folds: readonly string[],
): number {
  const [folded, setFolded] = useState(0);
  const measureRef = useRef<(() => void) | null>(null);
  const key = folds.join(" ");
  useLayoutEffect(() => {
    const rowElement = row.current;
    const regionElement = region.current;
    if (!rowElement || !regionElement) return;
    const attributes = key.split(" ").map((fold) => `data-${fold}`);
    const apply = (count: number) =>
      attributes.forEach((attribute, index) =>
        rowElement.toggleAttribute(attribute, index < count),
      );
    const measure = () => {
      let count = 0;
      apply(count);
      while (count < attributes.length && regionElement.scrollWidth > regionElement.clientWidth) {
        count += 1;
        apply(count);
      }
      setFolded(count);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(rowElement);
    const content = new MutationObserver(measure);
    content.observe(rowElement, { childList: true, subtree: true, characterData: true });
    measureRef.current = measure;
    measure();
    return () => {
      measureRef.current = null;
      resize.disconnect();
      content.disconnect();
      apply(0);
    };
  }, [row, region, key]);
  useLayoutEffect(() => {
    measureRef.current?.();
  });
  return folded;
}
