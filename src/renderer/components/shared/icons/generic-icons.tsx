import { MediaVolumeIcon } from "./file-viewer-icons";
import {
  CircleExclamationMark16Glyph,
  ExclamationMarkTriangle16Glyph,
  ArrowLeftLg20Glyph,
  ArrowRightLg20Glyph,
  ArrowUpArrowDown16Glyph,
  ChevronLeftLg16Glyph,
  CircleXmark20Glyph,
  ClipboardList16Glyph,
  ClipboardList20Glyph,
  Filter16Glyph,
  Filter20Glyph,
  PhotoBadgePlus16Glyph,
  SquareGrid2x216Glyph,
  SquareGrid2x220Glyph,
  Link16Glyph,
  Link20Glyph,
  Lock16Glyph,
  Lock20Glyph,
  ChatBubblePlus16Glyph,
  ChatBubblePlus20Glyph,
  MinusLg16Glyph,
  MinusLg20Glyph,
  EyeDropper16Glyph,
  PuzzlePiece16Glyph,
  ArrowRotateCounterclockwise16Glyph,
  PaperPlane16Glyph,
  ShieldCheckmark16Glyph,
  ShieldCheckmark20Glyph,
  Smartphone16Glyph,
  Smartphone20Glyph,
  Sparkles16Glyph,
  Sparkles20Glyph,
  CloudArrowUp16Glyph,
  CloudArrowUp20Glyph,
  Person16Glyph,
  Person20Glyph,
  MagicWand16Glyph,
  MagicWand20Glyph,
  CircleXmark16Glyph,
  Cube16Glyph,
  Cube20Glyph,
  Clipboard16Glyph,
  Clipboard20Glyph,
  Hand16Glyph,
  Hand20Glyph,
  ScreenArrowUp16Glyph,
  ScreenArrowUp20Glyph,
  MusicNote16Glyph,
  MusicNote20Glyph,
  TextFormat16Glyph,
  TextFormat20Glyph,
  Video16Glyph,
  Video20Glyph,
} from "./outline-glyphs";
import { forwardRef, type ComponentType } from "react";
import type { IconGlyphProps } from "./icon-glyph";
import {
  Reply as LucideReply,
  BoxSelect as LucideBoxSelect,
  CalendarClock as LucideCalendarClock,
  ChevronsLeftRight as LucideChevronsLeftRight,
  ChevronsRightLeft as LucideChevronsRightLeft,
  Circle as LucideCircle,
  CircleDotIcon as LucideCircleDotIcon,
  ContactRound as LucideContactRound,
  CornerDownRight as LucideCornerDownRight,
  GitBranchPlus as LucideGitBranchPlus,
  GitMerge as LucideGitMerge,
  Hash as LucideHash,
  KeyRound as LucideKeyRound,
  LayoutTemplate as LucideLayoutTemplate,
  ListTree as LucideListTree,
  MapPin as LucideMapPin,
  Maximize2 as LucideMaximize2,
  Minimize2 as LucideMinimize2,
  MonitorCog as LucideMonitorCog,
  PictureInPicture2 as LucidePictureInPicture2,
  Plug as LucidePlug,
  Printer as LucidePrinter,
  Route as LucideRoute,
  Rows3 as LucideRows3,
  Scissors as LucideScissors,
  Slash as LucideSlash,
  SlidersHorizontal as LucideSlidersHorizontal,
  SplitIcon as LucideSplitIcon,
  Star as LucideStar,
  TextCursorInput as LucideTextCursorInput,
  TextSelect as LucideTextSelect,
  WifiOff as LucideWifiOff,
  AppWindow as LucideAppWindow,
  Cookie as LucideCookie,
  Glasses as LucideGlasses,
  Hourglass as LucideHourglass,
  Network as LucideNetwork,
  type LucideIcon as LucideIconType,
  type LucideProps,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { IconSilhouette } from "./icon-silhouette";

export type LucideIcon = LucideIconType;

const DEFAULT_GENERIC_ICON_SIZE = 16;
const DEFAULT_GENERIC_ICON_STROKE_WIDTH = 1.75;
const GENERIC_ICON_GRID = 24;
const GENERIC_ICON_VIEW_BOX = `0 0 ${GENERIC_ICON_GRID} ${GENERIC_ICON_GRID}`;

/**
 * These glyphs are drawn from several strokes that cross, so each is painted as one silhouette:
 * a translucent text color then stays even instead of darkening at every crossing.
 */
function createGenericIcon(Icon: LucideIconType, displayName: string): LucideIconType {
  const GenericIcon = forwardRef<SVGSVGElement, LucideProps>(function GenericIcon(
    {
      "aria-hidden": ariaHidden,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      absoluteStrokeWidth = false,
      children,
      className,
      color,
      focusable = false,
      size = DEFAULT_GENERIC_ICON_SIZE,
      strokeWidth = DEFAULT_GENERIC_ICON_STROKE_WIDTH,
      style,
      ...props
    },
    ref,
  ) {
    const hasAccessibleName =
      ariaLabel !== undefined || ariaLabelledBy !== undefined || children !== undefined;

    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox={GENERIC_ICON_VIEW_BOX}
        fill="none"
        {...props}
        ref={ref}
        aria-hidden={hasAccessibleName ? ariaHidden : (ariaHidden ?? true)}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn("shrink-0", className)}
        focusable={focusable}
        style={color === undefined ? style : { ...style, color }}
      >
        <IconSilhouette>
          <Icon
            size={GENERIC_ICON_GRID}
            strokeWidth={
              absoluteStrokeWidth
                ? (Number(strokeWidth) * GENERIC_ICON_GRID) / Number(size)
                : strokeWidth
            }
          />
        </IconSilhouette>
        {children}
      </svg>
    );
  });
  GenericIcon.displayName = displayName;
  return GenericIcon as LucideIconType;
}

/** Filled outline masters keep their authored weight at the requested size. */
function createOutlineIcon(
  Glyph: ComponentType<IconGlyphProps>,
  displayName: string,
  LargeGlyph = Glyph,
): LucideIconType {
  const OutlineIcon = forwardRef<SVGSVGElement, LucideProps>(function OutlineIcon(
    {
      "aria-hidden": ariaHidden,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      absoluteStrokeWidth: _absoluteStrokeWidth,
      children,
      color,
      size = DEFAULT_GENERIC_ICON_SIZE,
      strokeWidth: _strokeWidth,
      style,
      ...props
    },
    ref,
  ) {
    const hasAccessibleName =
      ariaLabel !== undefined || ariaLabelledBy !== undefined || children !== undefined;
    const Master = Number(size) >= 20 ? LargeGlyph : Glyph;
    return (
      <Master
        width={size}
        height={size}
        {...props}
        ref={ref}
        aria-hidden={hasAccessibleName ? ariaHidden : (ariaHidden ?? true)}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        style={color === undefined ? style : { ...style, color }}
        svgChildren={children}
      />
    );
  });
  OutlineIcon.displayName = displayName;
  return OutlineIcon;
}

export const AlertCircle: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  CircleExclamationMark16Glyph,
  "AlertCircle",
);
export const AlertTriangle: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ExclamationMarkTriangle16Glyph,
  "AlertTriangle",
);
export const ArrowLeft: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ArrowLeftLg20Glyph,
  "ArrowLeft",
);
export const ArrowRight: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ArrowRightLg20Glyph,
  "ArrowRight",
);
export const ArrowUpDown: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ArrowUpArrowDown16Glyph,
  "ArrowUpDown",
);
export const BoxSelect: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideBoxSelect,
  "BoxSelect",
);
export const CalendarClock: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideCalendarClock,
  "CalendarClock",
);
export const ChevronLeft: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ChevronLeftLg16Glyph,
  "ChevronLeft",
);
export const ChevronsLeftRight: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideChevronsLeftRight,
  "ChevronsLeftRight",
);
export const ChevronsRightLeft: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideChevronsRightLeft,
  "ChevronsRightLeft",
);
export const Circle: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideCircle, "Circle");
export const CircleAlert: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  CircleExclamationMark16Glyph,
  "CircleAlert",
);
export const CircleDotIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideCircleDotIcon,
  "CircleDotIcon",
);
export const CircleX: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  CircleXmark20Glyph,
  "CircleX",
);
export const ClipboardListIcon: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ClipboardList16Glyph,
  "ClipboardListIcon",
  ClipboardList20Glyph,
);
export const ContactRound: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideContactRound,
  "ContactRound",
);
export const Reply: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideReply, "Reply");
export const CornerDownRight: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideCornerDownRight,
  "CornerDownRight",
);
export const Filter: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Filter16Glyph,
  "Filter",
  Filter20Glyph,
);
export const GitBranchPlus: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideGitBranchPlus,
  "GitBranchPlus",
);
export const Hash: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideHash, "Hash");
export const ImagePlus: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  PhotoBadgePlus16Glyph,
  "ImagePlus",
);
export const KeyRound: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideKeyRound,
  "KeyRound",
);
export const LayoutGrid: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  SquareGrid2x216Glyph,
  "LayoutGrid",
  SquareGrid2x220Glyph,
);
export const LayoutTemplate: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideLayoutTemplate,
  "LayoutTemplate",
);
export const Link2: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Link16Glyph,
  "Link2",
  Link20Glyph,
);
export const ListTree: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideListTree,
  "ListTree",
);
export const LockKeyhole: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Lock16Glyph,
  "LockKeyhole",
  Lock20Glyph,
);
export const Maximize2: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMaximize2,
  "Maximize2",
);
export const MessageCirclePlusIcon: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ChatBubblePlus16Glyph,
  "MessageCirclePlusIcon",
  ChatBubblePlus20Glyph,
);
export const Minimize2: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMinimize2,
  "Minimize2",
);
export const Minus: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  MinusLg16Glyph,
  "Minus",
  MinusLg20Glyph,
);
export const MonitorCog: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMonitorCog,
  "MonitorCog",
);
export const PictureInPicture2: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucidePictureInPicture2,
  "PictureInPicture2",
);
export const Pipette: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  EyeDropper16Glyph,
  "Pipette",
);
export const Plug: LucideIconType = /* @__PURE__ */ createGenericIcon(LucidePlug, "Plug");
export const Printer: LucideIconType = /* @__PURE__ */ createGenericIcon(LucidePrinter, "Printer");
export const Puzzle: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  PuzzlePiece16Glyph,
  "Puzzle",
);
export const RotateCcw: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ArrowRotateCounterclockwise16Glyph,
  "RotateCcw",
);
export const Route: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideRoute, "Route");
export const Rows3: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideRows3, "Rows3");
export const TextSelect: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideTextSelect,
  "TextSelect",
);
export const Scissors: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideScissors,
  "Scissors",
);
export const SendIcon: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  PaperPlane16Glyph,
  "SendIcon",
);
export const ShieldCheck: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ShieldCheckmark16Glyph,
  "ShieldCheck",
  ShieldCheckmark20Glyph,
);
export const Slash: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideSlash, "Slash");
export const SlidersHorizontal: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSlidersHorizontal,
  "SlidersHorizontal",
);
export const Smartphone: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Smartphone16Glyph,
  "Smartphone",
  Smartphone20Glyph,
);
export const Sparkles: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Sparkles16Glyph,
  "Sparkles",
  Sparkles20Glyph,
);
export const GitMergeIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideGitMerge,
  "GitMergeIcon",
);
export const SplitIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSplitIcon,
  "SplitIcon",
);
export const Star: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideStar, "Star");
export const TextCursorInput: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideTextCursorInput,
  "TextCursorInput",
);
export const TriangleAlert: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ExclamationMarkTriangle16Glyph,
  "TriangleAlert",
);
export const UploadCloud: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  CloudArrowUp16Glyph,
  "UploadCloud",
  CloudArrowUp20Glyph,
);
export const UserRound: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Person16Glyph,
  "UserRound",
  Person20Glyph,
);
export const Volume2: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  MediaVolumeIcon,
  "Volume2",
);
export const WandSparkles: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  MagicWand16Glyph,
  "WandSparkles",
  MagicWand20Glyph,
);
export const WifiOff: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideWifiOff, "WifiOff");
export const XCircle: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  CircleXmark16Glyph,
  "XCircle",
);
export const AppWindow: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideAppWindow,
  "AppWindow",
);
export const Box: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Cube16Glyph,
  "Box",
  Cube20Glyph,
);
export const Clipboard: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Clipboard16Glyph,
  "Clipboard",
  Clipboard20Glyph,
);
export const Cookie: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideCookie, "Cookie");
export const Glasses: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideGlasses, "Glasses");
export const Hand: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Hand16Glyph,
  "Hand",
  Hand20Glyph,
);
export const Hourglass: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideHourglass,
  "Hourglass",
);
export const MapPin: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideMapPin, "MapPin");
export const MonitorUp: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  ScreenArrowUp16Glyph,
  "MonitorUp",
  ScreenArrowUp20Glyph,
);
export const Music: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  MusicNote16Glyph,
  "Music",
  MusicNote20Glyph,
);
export const Network: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideNetwork, "Network");
export const Type: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  TextFormat16Glyph,
  "Type",
  TextFormat20Glyph,
);
export const Video: LucideIconType = /* @__PURE__ */ createOutlineIcon(
  Video16Glyph,
  "Video",
  Video20Glyph,
);
