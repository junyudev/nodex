import { memo } from "react";
import Svg, { Path } from "react-native-svg";

import { ICON_GLYPHS, type IconName } from "./icon-glyphs.generated";
import type { IconGlyph } from "./icon-glyphs";
import { useColor, type ColorToken } from "./tokens";

export type { IconName } from "./icon-glyphs.generated";

/**
 * The inks a glyph is drawn in. All are opaque: a glyph's shapes may overlap, and a translucent
 * wash would show darker wherever they do.
 */
export type IconColor = Exclude<ColorToken, "fill" | "glass" | "line">;

/**
 * One of the desktop's glyphs, at the phone's size and in one of its inks. Their geometry is
 * generated from the desktop's icon components; see `scripts/mobile-icons/mapping.ts`.
 */
export const Icon = memo(function Icon({
  name,
  size = 20,
  color = "ink-2",
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: IconColor;
}) {
  const ink = useColor(color);
  const glyph: IconGlyph = ICON_GLYPHS[name];
  return (
    <Svg width={size} height={size} viewBox={glyph.viewBox} fill="none">
      {glyph.paths.map((path, index) => (
        <Path
          key={index}
          d={path.d}
          fill={path.fill ?? ink}
          fillRule={path.fillRule}
          opacity={path.opacity}
          {...(path.stroke
            ? {
                stroke: ink,
                strokeWidth: path.strokeWidth ?? 1,
                strokeLinecap: path.strokeLinecap ?? "butt",
                strokeLinejoin: path.strokeLinejoin ?? "miter",
              }
            : {})}
        />
      ))}
    </Svg>
  );
});

const MARK_BODY =
  "M142.9 730.445 56.916 623.328C36.2282 597.558 25 565.865 25 533.248V145.375C25 96.5161 64.0898 55.9743 114.518 52.5313L513.303 25.3046C542.275 23.3266 571.07 31.0273 594.87 47.1176L734.98 141.848C760.063 158.805 775 186.525 775 216.107V657.08C775 704.895 736.565 744.483 687.19 747.523L244.583 774.768C205.183 777.193 167.1 760.593 142.9 730.445Z";

/** The Nodex mark: the block with its prompt, on the ink color so it follows the appearance. */
export const NodexMark = memo(function NodexMark({ size = 28 }: { readonly size?: number }) {
  const body = useColor("ink");
  const prompt = useColor("surface");
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800" fill="none">
      <Path d={MARK_BODY} fill={body} />
      <Path
        d="M305 352 411 438.203 305 535"
        stroke={prompt}
        strokeWidth={50}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M458.035 565.638 579.966 558.361"
        stroke={prompt}
        strokeWidth={50}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
});
