import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IconSilhouette } from "./icon-silhouette";

export type IconGlyphProps = Omit<JSX.IntrinsicElements["svg"], "children"> & {
  readonly svgChildren?: ReactNode;
};

export function IconGlyph({
  size,
  viewBox,
  className,
  children,
  svgChildren,
  ...props
}: IconGlyphProps & {
  readonly size: number;
  readonly viewBox: string;
  readonly children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      {...props}
    >
      <IconSilhouette>{children}</IconSilhouette>
      {svgChildren}
    </svg>
  );
}
