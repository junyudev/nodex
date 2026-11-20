import { EllipsisIcon } from "./customize-action-icons";
import {
  Terminal20Glyph,
  Archive16Glyph,
  CircleExclamationMark16Glyph,
  OpenLink16Glyph,
  ClockArrowRotateCounterclockwise16Glyph,
  ChatBubble16Glyph,
  ArrowLeftLg16Glyph,
  Tag16Glyph,
  ArrowUpMd16Glyph,
  ArrowDownMd16Glyph,
  Filter16Glyph,
  InfoCircle16Glyph,
  Eye16Glyph,
  EyeSlash16Glyph,
  Photo16Glyph,
  ArrowRotateClockwise16Glyph,
  Smartphone16Glyph,
  Notebook16Glyph,
  CheckmarkCircle16Glyph,
  CircleQuestionmark16Glyph,
  Sun16Glyph,
  PlaySmFill16Glyph,
} from "./outline-glyphs";
import { CopyLightIcon, BulletListIcon, MediaPauseIcon } from "./file-viewer-icons";
import type { ComponentType, SVGProps } from "react";
import type { IconGlyphProps } from "./icon-glyph";
import { IconSilhouette } from "./icon-silhouette";

export type CanonicalIconProps = SVGProps<SVGSVGElement> & {
  /** Convenience alias used by the older app-owned icon wrappers. */
  ariaHidden?: boolean;
};

type IconPath =
  | string
  | {
      readonly clipRule?: "evenodd";
      readonly d: string;
      readonly fill?: string;
      readonly fillRule?: "evenodd";
      readonly opacity?: number | string;
      readonly stroke?: string;
      readonly strokeLinecap?: "butt" | "round" | "square";
      readonly strokeLinejoin?: SVGProps<SVGPathElement>["strokeLinejoin"];
      readonly strokeWidth?: number | string;
      readonly transform?: string;
    };

type CanonicalGlyphProps = CanonicalIconProps & {
  height?: number | string;
  paths: readonly IconPath[];
  viewBox?: string;
  width?: number | string;
};

const isMonochromePaint = (paint: string | undefined): boolean =>
  paint === undefined || paint === "none" || paint === "currentColor";

const isMonochromePath = (path: IconPath): boolean =>
  typeof path === "string" || (isMonochromePaint(path.fill) && isMonochromePaint(path.stroke));

/** A stroke lies half over its own fill, so one such path already paints an area twice. */
const isFilledAndStroked = (path: IconPath): boolean =>
  typeof path !== "string" &&
  path.fill !== "none" &&
  path.stroke !== undefined &&
  path.stroke !== "none";

const DEFAULT_ICON_CLASS = "icon-xs shrink-0";

function canonicalAriaHidden({
  ariaHidden,
  "aria-hidden": ariaHiddenAttribute,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: CanonicalIconProps) {
  const hasAccessibleName = ariaLabel !== undefined || ariaLabelledBy !== undefined;
  return ariaHidden ?? ariaHiddenAttribute ?? (hasAccessibleName ? undefined : true);
}

function CanonicalOutlineGlyph({
  glyph: Glyph,
  className,
  ariaHidden,
  children,
  ...props
}: CanonicalIconProps & { glyph: ComponentType<IconGlyphProps> }) {
  return (
    <Glyph
      {...props}
      className={className ?? DEFAULT_ICON_CLASS}
      aria-hidden={canonicalAriaHidden({ ...props, ariaHidden })}
      svgChildren={children}
    />
  );
}

function CanonicalGlyph({
  paths,
  viewBox = "0 0 20 20",
  width = 20,
  height = 20,
  className,
  ariaHidden,
  "aria-hidden": ariaHiddenAttribute,
  ...svgProps
}: CanonicalGlyphProps) {
  // Several paths that cross are painted as one silhouette, so a translucent color stays even.
  const shapes = paths.map((path, index) => {
    if (typeof path === "string") {
      return <path key={`${path}-${index}`} d={path} fill="currentColor" />;
    }

    return (
      <path
        key={`${path.d}-${index}`}
        d={path.d}
        fill={path.fill ?? "currentColor"}
        fillRule={path.fillRule}
        clipRule={path.clipRule}
        opacity={path.opacity}
        stroke={path.stroke}
        strokeWidth={path.strokeWidth}
        strokeLinecap={path.strokeLinecap}
        strokeLinejoin={path.strokeLinejoin}
        transform={path.transform}
      />
    );
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...svgProps}
      className={className ?? DEFAULT_ICON_CLASS}
      aria-hidden={canonicalAriaHidden({
        ...svgProps,
        ariaHidden,
        "aria-hidden": ariaHiddenAttribute,
      })}
    >
      {paths.every(isMonochromePath) && (paths.length > 1 || paths.some(isFilledAndStroked)) ? (
        <IconSilhouette>{shapes}</IconSilhouette>
      ) : (
        shapes
      )}
    </svg>
  );
}

const LOADING_PATHS = [
  {
    d: "M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z",
    opacity: 0.3,
  },
  {
    d: "M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z",
  },
] as const;

export function CopyIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={CopyLightIcon} width={20} height={20} {...props} />;
}

export function MoreActionsIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={EllipsisIcon} {...props} width={21} height={21} />;
}

export function TerminalIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Terminal20Glyph} {...props} />;
}

export function BackIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={ArrowLeftLg16Glyph} width={20} height={20} {...props} />;
}

export function OpenExternalIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={OpenLink16Glyph} {...props} width={16} height={16} />;
}

/** A chat's identity wherever one appears: tabs, rows, mentions, sources, and activity. */
export function ChatIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={ChatBubble16Glyph} {...props} width={16} height={16} />;
}

export function DatabaseLabelIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Tag16Glyph} {...props} width={16} height={16} />;
}

export function SortAscendingIcon(props: CanonicalIconProps) {
  return <MoveUpIcon {...props} />;
}

export function SortDescendingIcon(props: CanonicalIconProps) {
  return <MoveDownIcon {...props} />;
}

export function MoveUpIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={ArrowUpMd16Glyph} width={20} height={20} {...props} />;
}

export function MoveDownIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={ArrowDownMd16Glyph} width={20} height={20} {...props} />;
}

export function FilterIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Filter16Glyph} width={20} height={20} {...props} />;
}

/** Drawn on the 16px toolbar grid to pair with the Board layout glyph. */
export function ListLayoutIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={BulletListIcon} {...props} width={16} height={16} />;
}

export function InfoIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={InfoCircle16Glyph} width={20} height={20} {...props} />;
}

export function HistoryIcon(props: CanonicalIconProps) {
  return (
    <CanonicalOutlineGlyph
      glyph={ClockArrowRotateCounterclockwise16Glyph}
      width={20}
      height={20}
      {...props}
    />
  );
}

/**
 * Static loading identity. Callers own any animation class or transition so
 * the glyph stays usable in reduced-motion and non-animated surfaces.
 */
export function LoadingIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph {...props} width={24} height={24} viewBox="0 0 24 24" paths={LOADING_PATHS} />
  );
}

export function VisibilityIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Eye16Glyph} width={20} height={20} {...props} />;
}

export function VisibilityOffIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={EyeSlash16Glyph} width={20} height={20} {...props} />;
}

export function ImageIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Photo16Glyph} {...props} width={24} height={24} />;
}

export function RetryIcon(props: CanonicalIconProps) {
  return (
    <CanonicalOutlineGlyph glyph={ArrowRotateClockwise16Glyph} width={20} height={20} {...props} />
  );
}

export function ResetIcon(props: CanonicalIconProps) {
  return <RetryIcon {...props} />;
}

export function PlayIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={PlaySmFill16Glyph} width={20} height={20} {...props} />;
}

export function PauseIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={MediaPauseIcon} width={20} height={20} {...props} />;
}

/** A line glyph at the house weight: a 1.33 stroke on the 20px grid with round ends. */
function lineGlyphPaths(...d: readonly string[]) {
  return d.map((path) => ({
    d: path,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.33,
  }));
}

// The kinds of a captured thought share one weight. Todo and question, both asking for work,
// share a 14px circle; a note is a 13px sheet, which reads as the same size beside them.

const SEND_TO_CHAT_PATHS = lineGlyphPaths(
  "M16.6 3.4 11.7 16.6a.6.6 0 0 1-1.1.03L8.4 11.6 3.37 9.4a.6.6 0 0 1 .03-1.1z",
  "m8.4 11.6 3.35-3.35",
);

const DISPATCH_PATHS = lineGlyphPaths(
  "M3 10h2.5c2.5 0 3.5-4.5 6-4.5h4.75M5.5 10c2.5 0 3.5 4.5 6 4.5h4.75",
  "M14 3.25l2.25 2.25L14 7.75M14 12.25l2.25 2.25L14 16.75",
);

// A lead on the left, its three subagents on the right: no arrowheads, because the parts branch
// from one plan rather than point somewhere.
const DELEGATION_MAP_PATHS = [
  ...lineGlyphPaths(
    "M2.75 10a1.75 1.75 0 1 0 3.5 0 1.75 1.75 0 1 0-3.5 0",
    "M6.25 10h1.5c2.6 0 2.4-5 5-5h1.5M6.25 10h8M7.75 10c2.6 0 2.4 5 5 5h1.5",
  ),
  "M14.25 5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0",
  "M14.25 10a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0",
  "M14.25 15a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0",
];

// Five points on round joins, so the star reads softly at the house line weight.
const STAR =
  "M10 3.55 11.79 8.18 16.75 8.46 12.9 11.59 14.17 16.39 10 13.7 5.83 16.39 7.1 11.59 3.25 8.46 8.21 8.18z";

const IMPORTANT_PATHS = lineGlyphPaths(STAR);

const IMPORTANT_FILLED_PATHS = lineGlyphPaths(STAR).map((path) => ({
  ...path,
  fill: "currentColor",
}));

/** Marking something important: an outlined star. */
export function ImportantIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={IMPORTANT_PATHS} />;
}

/** Something the user marked important: the same star, filled. */
export function ImportantFilledIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={IMPORTANT_FILLED_PATHS} />;
}

/** A phone paired with this Profile. */
export function MobileIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Smartphone16Glyph} width={20} height={20} {...props} />;
}

/** A thought kept for later: a sheet with its corner turned. */
export function NoteIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Notebook16Glyph} width={20} height={20} {...props} />;
}

/** Something to do: a check centered in its circle. */
export function TodoIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={CheckmarkCircle16Glyph} width={20} height={20} {...props} />;
}

/** Something to answer: a question mark centered in its circle. */
export function QuestionIcon(props: CanonicalIconProps) {
  return (
    <CanonicalOutlineGlyph glyph={CircleQuestionmark16Glyph} width={20} height={20} {...props} />
  );
}

export function SendToChatIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={SEND_TO_CHAT_PATHS} />;
}

/** Choosing where something goes: one path branching toward its destinations. */
export function DispatchIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={DISPATCH_PATHS} />;
}

/** A work tree drawn as a map: who leads, and who the work was delegated to. */
export function DelegationMapIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={DELEGATION_MAP_PATHS} />;
}

export function SunIcon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Sun16Glyph} width={20} height={20} {...props} />;
}

export function MoonIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      paths={[
        "M8.50195 5.83319C8.50197 4.93054 8.65078 4.06203 8.92188 3.24921C5.65928 3.76613 3.16504 6.59214 3.16504 10.0002C3.16514 13.775 6.2252 16.8351 10 16.8351C12.3126 16.8351 14.3565 15.6856 15.5938 13.926C11.5915 13.4005 8.50195 9.9788 8.50195 5.83319ZM9.83203 5.83319C9.83203 9.60806 12.8921 12.6682 16.667 12.6682C16.6833 12.6682 16.6996 12.6683 16.7158 12.6682C16.9467 12.6665 17.1618 12.7849 17.2842 12.9807C17.3913 13.1521 17.4145 13.3617 17.3496 13.55L17.3164 13.6291C15.9812 16.3161 13.2069 18.1652 10 18.1652C5.49066 18.1652 1.83506 14.5095 1.83496 10.0002C1.83496 5.51033 5.45891 1.8667 9.94141 1.83514L10.0273 1.84003C10.2248 1.86428 10.4027 1.97644 10.5098 2.14764C10.6321 2.34353 10.6447 2.58923 10.542 2.79608C10.0877 3.71023 9.83205 4.74091 9.83203 5.83319Z",
      ]}
    />
  );
}

/* Glyphs drawn on a 16px grid for dense notification surfaces, where scaled 20px artwork reads light. */
const CLOSE_16_PATHS: readonly IconPath[] = [
  "M10.9621 4.29539C11.167 4.09057 11.4992 4.09076 11.7043 4.29539C11.9093 4.50039 11.9092 4.83255 11.7043 5.03758L8.74235 7.99949L11.7052 10.9624C11.9098 11.1673 11.9097 11.4996 11.7052 11.7046C11.5003 11.9095 11.1681 11.9093 10.9631 11.7046L8.00016 8.74168L5.03727 11.7046C4.83222 11.9093 4.5 11.9095 4.29509 11.7046C4.09054 11.4996 4.09051 11.1673 4.29509 10.9624L7.25798 7.99949L4.29606 5.03758C4.09107 4.83255 4.09105 4.5004 4.29606 4.29539C4.50111 4.09079 4.83336 4.09054 5.03825 4.29539L8.00016 7.2573L10.9621 4.29539Z",
];
const SUCCESS_CIRCLE_16_PATHS: readonly IconPath[] = [
  "M9.82617 5.80469C9.98754 5.56401 10.3139 5.49907 10.5547 5.66016C10.795 5.82162 10.8602 6.14803 10.6992 6.38867L7.98633 10.4346C7.70834 10.8488 7.11691 10.8958 6.77637 10.5312L5.35352 9.00684C5.15579 8.7949 5.16712 8.46247 5.37891 8.26465C5.59087 8.06696 5.92331 8.07818 6.12109 8.29004L7.30664 9.56152L9.82617 5.80469Z",
  {
    d: "M8 1.47461C11.6037 1.47461 14.5254 4.39634 14.5254 8C14.5254 11.6037 11.6037 14.5254 8 14.5254C4.39634 14.5254 1.47461 11.6037 1.47461 8C1.47461 4.39634 4.39634 1.47461 8 1.47461ZM8 2.52539C4.97624 2.52539 2.52539 4.97624 2.52539 8C2.52539 11.0238 4.97624 13.4746 8 13.4746C11.0238 13.4746 13.4746 11.0238 13.4746 8C13.4746 4.97624 11.0238 2.52539 8 2.52539Z",
    fillRule: "evenodd",
    clipRule: "evenodd",
    fill: "currentColor",
  },
];

function Glyph16({
  paths,
  ...props
}: CanonicalIconProps & { readonly paths: readonly IconPath[] }) {
  return <CanonicalGlyph {...props} width={16} height={16} viewBox="0 0 16 16" paths={paths} />;
}

export function Archive16Icon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={Archive16Glyph} {...props} width={16} height={16} />;
}

export function Close16Icon(props: CanonicalIconProps) {
  return <Glyph16 {...props} paths={CLOSE_16_PATHS} />;
}

export function InfoCircle16Icon(props: CanonicalIconProps) {
  return <CanonicalOutlineGlyph glyph={InfoCircle16Glyph} {...props} width={16} height={16} />;
}

export function SuccessCircle16Icon(props: CanonicalIconProps) {
  return <Glyph16 {...props} paths={SUCCESS_CIRCLE_16_PATHS} />;
}

export function AlertCircle16Icon(props: CanonicalIconProps) {
  return (
    <CanonicalOutlineGlyph glyph={CircleExclamationMark16Glyph} {...props} width={16} height={16} />
  );
}
