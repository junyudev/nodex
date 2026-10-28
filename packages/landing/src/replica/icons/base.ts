import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement>;

/** Every glyph shares these defaults; a caller's class sets its size. */
export const base = (props: IconProps, viewBox: string, width = 16, height = width): IconProps => ({
  viewBox,
  width,
  height,
  "aria-hidden": props["aria-label"] || props["aria-labelledby"] ? undefined : true,
  focusable: false,
  ...props,
  className: `shrink-0 ${props.className ?? "size-4"}`,
});
