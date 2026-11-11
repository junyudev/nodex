import { useId, type ReactNode } from "react";

/**
 * Paints an icon's shapes as one silhouette. Icons take the text color, which is often
 * translucent; shapes painted one over another would show darker wherever they overlap. Inside
 * this, the shapes cut a single mask and the color is laid down once.
 *
 * Wrap the contents of an `<svg>` whose shapes use `currentColor`. A shape's own `opacity`
 * still reads as a lighter tone. Not for artwork with colors of its own.
 */
export function IconSilhouette({ children }: { readonly children: ReactNode }) {
  const maskId = useId();
  return (
    <>
      <mask id={maskId}>
        <g style={{ color: "white" }}>{children}</g>
      </mask>
      <rect width="100%" height="100%" fill="currentColor" mask={`url(#${maskId})`} />
    </>
  );
}
