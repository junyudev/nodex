import { forwardRef } from "react";
import {
  AlertCircle as LucideAlertCircle,
  AlertTriangle as LucideAlertTriangle,
  ArrowLeft as LucideArrowLeft,
  ArrowRight as LucideArrowRight,
  ArrowUpDown as LucideArrowUpDown,
  BoxSelect as LucideBoxSelect,
  CalendarClock as LucideCalendarClock,
  ChevronLeft as LucideChevronLeft,
  ChevronsLeftRight as LucideChevronsLeftRight,
  ChevronsRightLeft as LucideChevronsRightLeft,
  Circle as LucideCircle,
  CircleAlert as LucideCircleAlert,
  CircleDotIcon as LucideCircleDotIcon,
  CircleX as LucideCircleX,
  ClipboardListIcon as LucideClipboardListIcon,
  CloudOff as LucideCloudOff,
  Columns3 as LucideColumns3,
  ContactRound as LucideContactRound,
  CornerDownLeft as LucideCornerDownLeft,
  Filter as LucideFilter,
  Gauge as LucideGauge,
  GitBranchPlus as LucideGitBranchPlus,
  Hash as LucideHash,
  ImagePlus as LucideImagePlus,
  KeyRound as LucideKeyRound,
  Layers3 as LucideLayers3,
  LayoutGrid as LucideLayoutGrid,
  LayoutTemplate as LucideLayoutTemplate,
  Link2 as LucideLink2,
  ListTree as LucideListTree,
  LockKeyhole as LucideLockKeyhole,
  Maximize2 as LucideMaximize2,
  MessageCirclePlusIcon as LucideMessageCirclePlusIcon,
  MessageSquare as LucideMessageSquare,
  MessagesSquareIcon as LucideMessagesSquareIcon,
  Minimize2 as LucideMinimize2,
  Minus as LucideMinus,
  Monitor as LucideMonitor,
  MonitorCog as LucideMonitorCog,
  Moon as LucideMoon,
  PanelTopOpen as LucidePanelTopOpen,
  PictureInPicture2 as LucidePictureInPicture2,
  Plug as LucidePlug,
  Printer as LucidePrinter,
  Puzzle as LucidePuzzle,
  RotateCcw as LucideRotateCcw,
  Route as LucideRoute,
  Rows3 as LucideRows3,
  Scissors as LucideScissors,
  SendHorizontal as LucideSendHorizontal,
  SendIcon as LucideSendIcon,
  Shield as LucideShield,
  ShieldCheck as LucideShieldCheck,
  Slash as LucideSlash,
  SlidersHorizontal as LucideSlidersHorizontal,
  Smartphone as LucideSmartphone,
  Sparkles as LucideSparkles,
  SplitIcon as LucideSplitIcon,
  Star as LucideStar,
  Sun as LucideSun,
  Tags as LucideTags,
  TextCursorInput as LucideTextCursorInput,
  TriangleAlert as LucideTriangleAlert,
  UploadCloud as LucideUploadCloud,
  UserRound as LucideUserRound,
  Volume2 as LucideVolume2,
  WandSparkles as LucideWandSparkles,
  WifiOff as LucideWifiOff,
  XCircle as LucideXCircle,
  type LucideIcon as LucideIconType,
  type LucideProps,
} from "lucide-react";

import { cn } from "@/lib/utils";

export type LucideIcon = LucideIconType;

const DEFAULT_GENERIC_ICON_SIZE = 16;
const DEFAULT_GENERIC_ICON_STROKE_WIDTH = 1.75;

function createGenericIcon(Icon: LucideIconType, displayName: string): LucideIconType {
  const GenericIcon = forwardRef<SVGSVGElement, LucideProps>(function GenericIcon(
    {
      "aria-hidden": ariaHidden,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      children,
      className,
      focusable = false,
      size = DEFAULT_GENERIC_ICON_SIZE,
      strokeWidth = DEFAULT_GENERIC_ICON_STROKE_WIDTH,
      ...props
    },
    ref,
  ) {
    const hasAccessibleName =
      ariaLabel !== undefined || ariaLabelledBy !== undefined || children !== undefined;

    return (
      <Icon
        {...props}
        ref={ref}
        aria-hidden={hasAccessibleName ? ariaHidden : (ariaHidden ?? true)}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn("shrink-0", className)}
        focusable={focusable}
        size={size}
        strokeWidth={strokeWidth}
      >
        {children}
      </Icon>
    );
  });
  GenericIcon.displayName = displayName;
  return GenericIcon as LucideIconType;
}

export const AlertCircle: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideAlertCircle,
  "AlertCircle",
);
export const AlertTriangle: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideAlertTriangle,
  "AlertTriangle",
);
export const ArrowLeft: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideArrowLeft,
  "ArrowLeft",
);
export const ArrowRight: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideArrowRight,
  "ArrowRight",
);
export const ArrowUpDown: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideArrowUpDown,
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
export const ChevronLeft: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideChevronLeft,
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
export const CircleAlert: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideCircleAlert,
  "CircleAlert",
);
export const CircleDotIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideCircleDotIcon,
  "CircleDotIcon",
);
export const CircleX: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideCircleX, "CircleX");
export const ClipboardListIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideClipboardListIcon,
  "ClipboardListIcon",
);
export const CloudOff: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideCloudOff,
  "CloudOff",
);
export const Columns3: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideColumns3,
  "Columns3",
);
export const ContactRound: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideContactRound,
  "ContactRound",
);
export const CornerDownLeft: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideCornerDownLeft,
  "CornerDownLeft",
);
export const Filter: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideFilter, "Filter");
export const Gauge: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideGauge, "Gauge");
export const GitBranchPlus: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideGitBranchPlus,
  "GitBranchPlus",
);
export const Hash: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideHash, "Hash");
export const ImagePlus: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideImagePlus,
  "ImagePlus",
);
export const KeyRound: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideKeyRound,
  "KeyRound",
);
export const Layers3: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideLayers3, "Layers3");
export const LayoutGrid: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideLayoutGrid,
  "LayoutGrid",
);
export const LayoutTemplate: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideLayoutTemplate,
  "LayoutTemplate",
);
export const Link2: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideLink2, "Link2");
export const ListTree: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideListTree,
  "ListTree",
);
export const LockKeyhole: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideLockKeyhole,
  "LockKeyhole",
);
export const Maximize2: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMaximize2,
  "Maximize2",
);
export const MessageCirclePlusIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMessageCirclePlusIcon,
  "MessageCirclePlusIcon",
);
export const MessageSquare: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMessageSquare,
  "MessageSquare",
);
export const MessagesSquareIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMessagesSquareIcon,
  "MessagesSquareIcon",
);
export const Minimize2: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMinimize2,
  "Minimize2",
);
export const Minus: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideMinus, "Minus");
export const Monitor: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideMonitor, "Monitor");
export const MonitorCog: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideMonitorCog,
  "MonitorCog",
);
export const Moon: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideMoon, "Moon");
export const PanelTopOpen: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucidePanelTopOpen,
  "PanelTopOpen",
);
export const PictureInPicture2: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucidePictureInPicture2,
  "PictureInPicture2",
);
export const Plug: LucideIconType = /* @__PURE__ */ createGenericIcon(LucidePlug, "Plug");
export const Printer: LucideIconType = /* @__PURE__ */ createGenericIcon(LucidePrinter, "Printer");
export const Puzzle: LucideIconType = /* @__PURE__ */ createGenericIcon(LucidePuzzle, "Puzzle");
export const RotateCcw: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideRotateCcw,
  "RotateCcw",
);
export const Route: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideRoute, "Route");
export const Rows3: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideRows3, "Rows3");
export const Scissors: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideScissors,
  "Scissors",
);
export const SendHorizontal: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSendHorizontal,
  "SendHorizontal",
);
export const SendIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSendIcon,
  "SendIcon",
);
export const Shield: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideShield, "Shield");
export const ShieldCheck: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideShieldCheck,
  "ShieldCheck",
);
export const Slash: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideSlash, "Slash");
export const SlidersHorizontal: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSlidersHorizontal,
  "SlidersHorizontal",
);
export const Smartphone: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSmartphone,
  "Smartphone",
);
export const Sparkles: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSparkles,
  "Sparkles",
);
export const SplitIcon: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideSplitIcon,
  "SplitIcon",
);
export const Star: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideStar, "Star");
export const Sun: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideSun, "Sun");
export const Tags: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideTags, "Tags");
export const TextCursorInput: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideTextCursorInput,
  "TextCursorInput",
);
export const TriangleAlert: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideTriangleAlert,
  "TriangleAlert",
);
export const UploadCloud: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideUploadCloud,
  "UploadCloud",
);
export const UserRound: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideUserRound,
  "UserRound",
);
export const Volume2: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideVolume2, "Volume2");
export const WandSparkles: LucideIconType = /* @__PURE__ */ createGenericIcon(
  LucideWandSparkles,
  "WandSparkles",
);
export const WifiOff: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideWifiOff, "WifiOff");
export const XCircle: LucideIconType = /* @__PURE__ */ createGenericIcon(LucideXCircle, "XCircle");
