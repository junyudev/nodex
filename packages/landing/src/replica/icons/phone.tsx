// Nodex Mobile's own glyphs, exactly as packages/mobile/src/ui/icons.tsx draws them: a 20 unit grid
// with a 1.33 stroke, round caps and joins. The color comes from the text around them.
import { base, type IconProps } from "./base";

const LINE_GLYPHS = {
  plus: ["M10 4.5v11", "M4.5 10h11"],
  arrowUp: ["M10 15.5v-11", "M5.5 9 10 4.5 14.5 9"],
  inbox: [
    "M3.5 11.5l2-6.2a1.2 1.2 0 0 1 1.15-.8h6.7a1.2 1.2 0 0 1 1.15.8l2 6.2v3a1.5 1.5 0 0 1-1.5 1.5h-10a1.5 1.5 0 0 1-1.5-1.5v-3Z",
    "M3.5 11.5h3.6l1 1.8h3.8l1-1.8h3.6",
  ],
  chat: [
    "M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.4 2.4V14h-.1A1.5 1.5 0 0 1 4 12.5v-7Z",
  ],
  search: ["M9 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z", "M13 13l3.5 3.5"],
  chevronDown: ["M6 8l4 4 4-4"],
  chevronRight: ["M8 6l4 4-4 4"],
  // The system's back control, which the app's own glyphs have no need for.
  chevronLeft: ["M12.5 4.5 7 10l5.5 5.5"],
  check: ["M5 10.5l3.2 3.2L15 6.5"],
  clock: ["M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z", "M10 6.5V10l2.3 1.6"],
  history: ["M4 10a6 6 0 1 0 1.8-4.3L3.5 8", "M3.5 4.5V8H7", "M10 7v3.2l2.2 1.5"],
  warning: ["M10 4l6.8 11.5H3.2L10 4Z", "M10 8.5v3.2", "M10 13.7v.01"],
  agent: ["M10 3.5l1.5 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.5-4.9L3.6 10l4.9-1.6L10 3.5Z"],
} as const;

const STOP_GLYPH =
  "M7 5.5h6A1.5 1.5 0 0 1 14.5 7v6a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 13V7A1.5 1.5 0 0 1 7 5.5Z";

export type PhoneGlyphName = keyof typeof LINE_GLYPHS | "stop";

export function PhoneGlyph({
  name,
  size = 20,
  className,
}: {
  readonly name: PhoneGlyphName;
  readonly size?: number;
  readonly className?: string;
}) {
  const shared = { width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": true } as const;
  if (name === "stop") {
    return (
      <svg {...shared} className={`shrink-0 ${className ?? ""}`} fill="currentColor">
        <path d={STOP_GLYPH} />
      </svg>
    );
  }
  return (
    <svg
      {...shared}
      className={`shrink-0 ${className ?? ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.33}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {LINE_GLYPHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The Nodex mark on the ink color, with its prompt cut from the surface, as the app's header draws it. */
export function PhoneMark({ size = 22 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 800 800" fill="none" aria-hidden="true">
      <path
        className="fill-phone-ink"
        d="M142.9 730.445 56.916 623.328C36.2282 597.558 25 565.865 25 533.248V145.375C25 96.5161 64.0898 55.9743 114.518 52.5313L513.303 25.3046C542.275 23.3266 571.07 31.0273 594.87 47.1176L734.98 141.848C760.063 158.805 775 186.525 775 216.107V657.08C775 704.895 736.565 744.483 687.19 747.523L244.583 774.768C205.183 777.193 167.1 760.593 142.9 730.445Z"
      />
      <path
        className="stroke-phone-surface"
        d="M305 352 411 438.203 305 535"
        strokeWidth={50}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="stroke-phone-surface"
        d="M458.035 565.638 579.966 558.361"
        strokeWidth={50}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <svg
      {...base(props, "0 0 16 16")}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.6" />
      <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" />
    </svg>
  );
}
