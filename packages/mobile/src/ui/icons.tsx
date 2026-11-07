import { memo } from "react";
import Svg, { Path } from "react-native-svg";

import { useColor, type ColorToken } from "./tokens";

/** Nodex's line glyphs: a 20 unit grid, a 1.33 stroke, round caps and joins. */
const LINE_GLYPHS = {
  plus: ["M10 4.5v11", "M4.5 10h11"],
  arrowUp: ["M10 15.5v-11", "M5.5 9 10 4.5 14.5 9"],
  arrowDown: ["M10 4.5v11", "M5.5 11 10 15.5 14.5 11"],
  bell: [
    "M5.8 13.5c.7-.9 1.2-1.7 1.2-4.2a3 3 0 0 1 6 0c0 2.5.5 3.3 1.2 4.2a.6.6 0 0 1-.5 1H6.3a.6.6 0 0 1-.5-1Z",
    "M8.6 16.5c.3.4.8.6 1.4.6s1.1-.2 1.4-.6",
  ],
  inbox: [
    "M3.5 11.5l2-6.2a1.2 1.2 0 0 1 1.15-.8h6.7a1.2 1.2 0 0 1 1.15.8l2 6.2v3a1.5 1.5 0 0 1-1.5 1.5h-10a1.5 1.5 0 0 1-1.5-1.5v-3Z",
    "M3.5 11.5h3.6l1 1.8h3.8l1-1.8h3.6",
  ],
  chat: [
    "M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.4 2.4V14h-.1A1.5 1.5 0 0 1 4 12.5v-7Z",
  ],
  search: ["M9 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z", "M13 13l3.5 3.5"],
  close: ["M5.5 5.5l9 9", "M14.5 5.5l-9 9"],
  chevronDown: ["M6 8l4 4 4-4"],
  chevronRight: ["M8 6l4 4-4 4"],
  check: ["M5 10.5l3.2 3.2L15 6.5"],
  circle: ["M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z"],
  clock: ["M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z", "M10 6.5V10l2.3 1.6"],
  history: ["M4 10a6 6 0 1 0 1.8-4.3L3.5 8", "M3.5 4.5V8H7", "M10 7v3.2l2.2 1.5"],
  warning: ["M10 4l6.8 11.5H3.2L10 4Z", "M10 8.5v3.2", "M10 13.7v.01"],
  terminal: [
    "M4.5 4.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z",
    "M6.5 8l2.2 2-2.2 2",
    "M10.5 12.5h3",
  ],
  file: [
    "M6 3.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z",
    "M11 3.5V7h3.5",
  ],
  globe: [
    "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z",
    "M3.5 10h13",
    "M10 3.5c1.9 1.8 2.8 4 2.8 6.5s-.9 4.7-2.8 6.5c-1.9-1.8-2.8-4-2.8-6.5s.9-4.7 2.8-6.5Z",
  ],
  tool: ["M11 3.5 5 11h4l-1 5.5L14 9h-4l1-5.5Z"],
  agent: ["M10 3.5l1.5 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.5-4.9L3.6 10l4.9-1.6L10 3.5Z"],
  list: ["M7.5 5.5h9", "M7.5 10h9", "M7.5 14.5h9", "M3.8 5.5h.01", "M3.8 10h.01", "M3.8 14.5h.01"],
  photo: [
    "M4.5 4.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z",
    "M3.5 13l3.6-3.4 2.8 2.6 2.2-2 4.4 4",
    "M12.8 7.5h.01",
  ],
  camera: [
    "M4.5 6.5h2l1.2-2h4.6l1.2 2h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z",
    "M10 13a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z",
  ],
  star: [
    "M10 3.6l1.95 4.1 4.45.6-3.25 3.1.8 4.5L10 13.75 6.05 15.9l.8-4.5L3.6 8.3l4.45-.6L10 3.6Z",
  ],
  trash: ["M4.5 6h11", "M8 6V4.5h4V6", "M6 6l.6 9.5h6.8L14 6"],
  undo: ["M7.5 5.5 4 9l3.5 3.5", "M4 9h7.5a3.5 3.5 0 0 1 0 7H9"],
  laptop: [
    "M5 5.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V12H5V5.5Z",
    "M3 15.5h14",
    "M3 15.5 5 12",
    "M17 15.5 15 12",
  ],
  branch: [
    "M6.5 7.5v5",
    "M6.5 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "M6.5 16.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "M13.5 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "M13.5 7.5c0 3-7 2-7 5",
  ],
  link: [
    "M8.5 11.5l3-3",
    "M9 6.5l1-1a3 3 0 1 1 4.5 4.5l-1 1",
    "M11 13.5l-1 1a3 3 0 1 1-4.5-4.5l1-1",
  ],
  scan: [
    "M4 7V5a1 1 0 0 1 1-1h2",
    "M13 4h2a1 1 0 0 1 1 1v2",
    "M16 13v2a1 1 0 0 1-1 1h-2",
    "M7 16H5a1 1 0 0 1-1-1v-2",
    "M4 10h12",
  ],
  folder: [
    "M3.5 6a1 1 0 0 1 1-1h3.6l1.6 1.8h5.8a1 1 0 0 1 1 1V14.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6Z",
  ],
  thought: [
    "M10 4a4.6 4.6 0 0 0-2.7 8.3c.5.4.7.9.7 1.5h4c0-.6.2-1.1.7-1.5A4.6 4.6 0 0 0 10 4Z",
    "M8.4 16.2h3.2",
  ],
} as const;

/** Glyphs that are solid shapes rather than strokes. */
const SOLID_GLYPHS = {
  stop: "M7 5.5h6A1.5 1.5 0 0 1 14.5 7v6a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 13V7A1.5 1.5 0 0 1 7 5.5Z",
  starFilled:
    "M10 3.6l1.95 4.1 4.45.6-3.25 3.1.8 4.5L10 13.75 6.05 15.9l.8-4.5L3.6 8.3l4.45-.6L10 3.6Z",
  more: "M5 8.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm5 0a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm5 0a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z",
} as const;

export type IconName = keyof typeof LINE_GLYPHS | keyof typeof SOLID_GLYPHS;

export const Icon = memo(function Icon({
  name,
  size = 20,
  color = "ink-2",
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: ColorToken;
}) {
  const stroke = useColor(color);
  if (name in SOLID_GLYPHS) {
    return (
      <Svg width={size} height={size} viewBox="0 0 20 20">
        <Path d={SOLID_GLYPHS[name as keyof typeof SOLID_GLYPHS]} fill={stroke} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      {LINE_GLYPHS[name as keyof typeof LINE_GLYPHS].map((d) => (
        <Path
          key={d}
          d={d}
          stroke={stroke}
          strokeWidth={1.33}
          strokeLinecap="round"
          strokeLinejoin="round"
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
