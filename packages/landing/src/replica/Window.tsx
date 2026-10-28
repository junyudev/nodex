import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ClaudeMark,
  ClockIcon,
  CloseIcon,
  HomeIcon,
  NodexMarkIcon,
  OpenAIMark,
  OpenCodeMark,
  PagesIcon,
  PanelIcon,
  PluginsIcon,
  PlusIcon,
  SidebarHiddenIcon,
  SidebarIcon,
  SidebarSearchIcon,
} from "./icons";
import { WEEKLY_LEFT, type AgentChoice, type ProviderKind } from "../demos/lumen";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
export { cx };

// Shell measurements follow the 1440px desktop at the demos' 0.82 scale.
const RAIL = 42.64;
const SIDEBAR = 236.16;
// The content frame's right inset, and the bottom-panel toggle the outermost tab group leaves room for.
const FRAME_INSET = 3.28;
const PANEL_TOGGLE = 29.52;
const SIDE_OPEN = { duration: 0.45, ease: [0.2, 0.8, 0.2, 1] } as const;

/** A second tab group open beside the main one, such as a chat's Page on the right. */
export interface SideGroup {
  readonly tabs: ReactNode;
  /** Its pane width once open; it opens from the window's right edge. */
  readonly width: number;
  readonly children: ReactNode;
}
const RING_CIRCUMFERENCE = 2 * Math.PI * 12;

/**
 * Shared desktop chrome: titlebar, navigation rail, contextual sidebar and the content frame. The
 * frame holds the main tab group and, optionally, a side group; each group's tabs sit in the
 * titlebar above its own pane.
 */
export function AppWindow({
  sidebar,
  rail = sidebar !== undefined,
  tabs,
  side,
  overlay,
  usage,
  focusedUsage = null,
  children,
  className,
}: {
  readonly sidebar?: ReactNode;
  /** The navigation rail shows with the sidebar by default, or alone when asked. */
  readonly rail?: boolean;
  /** The rail meter whose card is open. */
  readonly focusedUsage?: ProviderKind | null;
  readonly tabs?: ReactNode;
  readonly side?: SideGroup;
  /** Drawn above everything, in window coordinates, such as a demo's pointer. */
  readonly overlay?: ReactNode;
  /** Remaining share of each account's tightest window, shown on the rail's meters. */
  readonly usage?: { readonly claude: number; readonly codex: number };
  readonly children: ReactNode;
  readonly className?: string;
}) {
  // One width drives the side pane and its titlebar strip, so their edges stay together as it opens.
  const sideWidth = useMotionValue(0);
  const sideStrip = useTransform(sideWidth, (width) =>
    Math.max(0, width + FRAME_INSET - PANEL_TOGGLE),
  );
  const sideTarget = side?.width ?? 0;
  useEffect(() => {
    const opening = animate(sideWidth, sideTarget, SIDE_OPEN);
    return () => opening.stop();
  }, [sideWidth, sideTarget]);

  return (
    <div
      data-app-window
      className={cx(
        "relative flex h-full w-full flex-col overflow-hidden rounded-[14px] bg-[#f6f6f6] font-app text-[11.48px] leading-[17.22px] font-[430] text-app-fg antialiased shadow-window select-none dark:bg-[#141414]",
        "[--app-fg:#1a1c1f] [--app-muted:rgb(26_28_31/0.695)] [--app-faint:rgb(26_28_31/0.495)] [--usage-low:#d8a32f] [--usage-critical:#e56458] dark:[--app-fg:#fff] dark:[--app-muted:rgb(255_255_255/0.71)] dark:[--app-faint:rgb(255_255_255/0.498)] dark:[--usage-low:#eac26b] dark:[--usage-critical:#e97366]",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[#f6f6f6]/85 dark:bg-[#282828]/80"
      />
      <div data-window-titlebar className="relative flex h-[36.08px] shrink-0 items-center">
        <div
          className="flex shrink-0 items-center gap-[6.56px] pl-[13.12px]"
          style={{ width: sidebar ? (rail ? RAIL : 0) + SIDEBAR : 154 }}
        >
          <span className="size-[9.84px] shrink-0 rounded-full bg-[#ff5f57]" />
          <span className="size-[9.84px] shrink-0 rounded-full bg-[#febc2e]" />
          <span className="size-[9.84px] shrink-0 rounded-full bg-[#28c840]" />
          <span className="ml-[11.48px] flex items-center gap-[4.92px] text-app-faint [&>span]:flex [&>span]:size-[19.68px] [&>span]:items-center [&>span]:justify-center">
            <span>
              <ArrowLeftIcon className="size-[13.12px]" />
            </span>
            <span className="opacity-40">
              <ArrowRightIcon className="size-[13.12px]" />
            </span>
            <span>
              {sidebar ? (
                <SidebarIcon className="size-[13.12px]" />
              ) : (
                <SidebarHiddenIcon className="size-[13.12px]" />
              )}
            </span>
          </span>
        </div>
        <TabStrip className="flex-1">{tabs}</TabStrip>
        {side ? (
          <motion.div
            data-side-group-tabs
            style={{ width: sideStrip }}
            className="relative flex h-full shrink-0 overflow-hidden before:absolute before:inset-y-[9.84px] before:left-0 before:w-px before:bg-app-line"
          >
            <TabStrip className="flex-1">{side.tabs}</TabStrip>
          </motion.div>
        ) : null}
        <span
          aria-label="Toggle bottom panel"
          className="mr-[6.56px] flex size-[22.96px] shrink-0 items-center justify-center text-app-faint"
        >
          <PanelIcon className="size-[14.76px]" />
        </span>
      </div>
      <div className="relative flex min-h-0 flex-1 pr-[3.28px] pb-[3.28px]">
        {rail ? <Rail usage={usage ?? WEEKLY_LEFT} focused={focusedUsage} /> : null}
        <div className="relative flex min-w-0 flex-1 overflow-hidden rounded-[9.84px] [corner-shape:superellipse(1.5)] shadow-[0_0_0_0.41px_var(--app-line),0_3.28px_13.12px_#0000000d]">
          {sidebar ? (
            <aside
              className="flex shrink-0 flex-col border-r-[0.41px] border-app-line bg-app/65"
              style={{ width: SIDEBAR }}
            >
              {sidebar}
            </aside>
          ) : null}
          <div className="relative flex min-w-0 flex-1 overflow-hidden bg-app">
            <div className="relative min-w-0 flex-1">{children}</div>
            {side ? (
              <motion.div
                data-side-group
                style={{ width: sideWidth }}
                className="relative shrink-0 overflow-hidden border-l border-app-line"
              >
                {/* Laid out at its open width, so it slides in without reflowing. */}
                <div className="absolute inset-y-0 left-0" style={{ width: side.width }}>
                  {side.children}
                </div>
              </motion.div>
            ) : null}
          </div>
        </div>
      </div>
      {overlay}
    </div>
  );
}

/** One tab group's tabs and its New tab button; a chat's plain heading stands alone. */
function TabStrip({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cx(
        "flex min-w-0 items-center gap-[6.56px] px-[6.56px] [&:has([data-window-heading])]:pl-0 [&:has([data-window-heading])>div:not([data-window-heading])]:hidden",
        className,
      )}
    >
      {children}
      <div
        aria-label="New tab"
        className="flex size-[22.96px] shrink-0 items-center justify-center text-app-faint"
      >
        <PlusIcon className="size-[16.4px]" />
      </div>
    </div>
  );
}

function Rail({
  usage,
  focused,
}: {
  readonly usage: { readonly claude: number; readonly codex: number };
  readonly focused: ProviderKind | null;
}) {
  const controlClass =
    "flex size-[29.52px] shrink-0 items-center justify-center rounded-[10.25px] [corner-shape:superellipse(1.5)]";
  return (
    <nav
      aria-label="App navigation"
      className="flex shrink-0 flex-col items-center justify-between pt-[6.56px] pb-[3.28px]"
      style={{ width: RAIL }}
    >
      <div className="flex flex-col items-center gap-[6.56px] text-app-faint">
        <span
          aria-label="Home"
          aria-current="page"
          className={cx(controlClass, "bg-app-hover text-app-fg")}
        >
          <HomeIcon filled className="size-[16.4px]" />
        </span>
        <span aria-label="Space" className={controlClass}>
          <PagesIcon className="size-[16.4px]" />
        </span>
        <span aria-label="Scheduled" className={controlClass}>
          <ClockIcon className="size-[16.4px]" />
        </span>
        <span aria-label="Plugins" className={controlClass}>
          <PluginsIcon className="size-[16.4px]" />
        </span>
      </div>
      <div className="flex flex-col items-center gap-[6.56px] text-app-faint">
        <span
          data-cursor-target="usage:claude"
          className={cx(controlClass, focused === "claude" && "bg-app-hover text-app-fg")}
        >
          <UsageRing left={usage.claude} kind="claude" />
        </span>
        <span
          data-cursor-target="usage:codex"
          className={cx(controlClass, focused === "codex" && "bg-app-hover text-app-fg")}
        >
          <UsageRing left={usage.codex} kind="codex" />
        </span>
        <span aria-label="Nodex account" className={controlClass}>
          <NodexMarkIcon className="size-[16.4px]" />
        </span>
      </div>
    </nav>
  );
}

/** UsageRingGlyph geometry and severity thresholds from workbench-rail-usage-meter.tsx. */
export function UsageRing({
  left,
  kind,
  className = "size-[19.68px]",
}: {
  readonly left: number;
  readonly kind: ProviderKind;
  readonly className?: string;
}) {
  const remaining = Math.max(0, Math.min(1, left));
  const exhausted = remaining === 0;
  const tone =
    remaining <= 0.15
      ? "var(--usage-critical)"
      : remaining <= 0.35
        ? "var(--usage-low)"
        : "currentColor";
  return (
    <span className={cx("relative inline-flex shrink-0 items-center justify-center", className)}>
      <svg
        viewBox="0 0 28 28"
        className="absolute inset-0 size-full -rotate-90 overflow-visible"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="14"
          cy="14"
          r="12"
          strokeWidth="2.25"
          strokeLinecap="round"
          stroke={exhausted ? tone : "currentColor"}
          strokeOpacity={exhausted ? 0.45 : 0.16}
        />
        {remaining > 0 ? (
          <circle
            cx="14"
            cy="14"
            r="12"
            strokeWidth="2.25"
            strokeLinecap="round"
            stroke={tone}
            strokeDasharray={RING_CIRCUMFERENCE.toFixed(3)}
            strokeDashoffset={(RING_CIRCUMFERENCE * (1 - remaining)).toFixed(3)}
            className="transition-[stroke-dashoffset,stroke,stroke-opacity] duration-500 ease-out motion-reduce:transition-none"
          />
        ) : null}
      </svg>
      <ProviderMark kind={kind} className="size-[9.84px] fill-current" />
    </span>
  );
}

/** The Inbox is a fixed leading tab; ordinary active tabs have a close affordance. */
export function Tab({
  icon,
  label,
  active = false,
  closable = label !== "Inbox",
  titleOnly = false,
}: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly active?: boolean;
  readonly closable?: boolean;
  /** A full-view chat occupies the titlebar with a plain heading instead of a tab strip. */
  readonly titleOnly?: boolean;
}) {
  if (titleOnly) {
    return (
      <div
        data-window-heading
        className="flex h-[19.68px] min-w-0 flex-1 items-center border-l-[0.41px] border-app-line pl-[9.84px] text-[11.48px] font-medium"
      >
        <span className="truncate">{label}</span>
      </div>
    );
  }
  return (
    <div
      className={cx(
        "relative flex h-[26.24px] w-[127.92px] min-w-0 items-center gap-[6.56px] rounded-[8.2px] px-[8.2px] text-[10.66px] leading-[15.23px] [corner-shape:superellipse(1.5)]",
        active
          ? "bg-white text-app-fg shadow-[0_0_0_0.41px_var(--app-line),0_0.82px_1.64px_-0.82px_#00000014] dark:bg-app-hover"
          : "text-app-faint",
      )}
    >
      {icon ? (
        <span className="flex size-[13.12px] shrink-0 items-center justify-center [&>svg]:size-full">
          {icon}
        </span>
      ) : null}
      {/* Long titles fade out rather than ellipsize, as app-shell-tabs.tsx draws them. */}
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,#000_calc(100%-14px),transparent)]">
        {label}
      </span>
      {active && closable ? <CloseIcon className="size-[11.48px] text-app-faint" /> : null}
    </div>
  );
}

/** A tab that just opened eases in beside the ones already there. */
export function NewTab({ children }: { readonly children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
      className="flex min-w-0"
    >
      {children}
    </motion.div>
  );
}

/** A tab group's pane: switching its tab cross-fades the content in place. */
export function TabGroupContent({
  group,
}: {
  readonly group: { readonly key: string; readonly content: ReactNode };
}) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      <motion.div
        key={group.key}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="absolute inset-0"
      >
        {group.content}
      </motion.div>
    </AnimatePresence>
  );
}

/** SurfaceToolbar chrome, shared by Inbox/History and saved Database Views. */
export function PaneHeader({
  left,
  right,
}: {
  readonly left: ReactNode;
  readonly right?: ReactNode;
}) {
  return (
    <div className="flex h-[32.8px] shrink-0 items-center justify-between pr-[6.56px] pl-[13.12px]">
      <div className="flex min-w-0 items-center gap-[6.56px]">{left}</div>
      <div className="flex shrink-0 items-center gap-[9.84px] text-app-faint [&>svg]:size-[13.12px]">
        {right}
      </div>
    </div>
  );
}

export function PaneTab({
  icon,
  label,
  count,
  active = false,
}: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly count?: number;
  readonly active?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-[26.24px] shrink-0 items-center justify-center gap-[4.92px] rounded-full px-[9.84px] text-[10.66px] leading-[13.78px] font-medium [&>svg]:size-[13.12px]",
        active ? "bg-app-fg/5 text-app-fg" : "text-app-muted",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {count ? <span className="text-app-faint tabular-nums">{count}</span> : null}
    </span>
  );
}

export function SidebarHeader() {
  return (
    <div className="mr-[9.84px] ml-[13.12px] flex h-[42.64px] shrink-0 items-center justify-between">
      <span className="min-w-0 truncate text-[14.76px] leading-[19.68px] font-semibold">Nodex</span>
      <span className="flex size-[22.96px] items-center justify-center text-app-faint">
        <SidebarSearchIcon className="size-[13.12px]" />
      </span>
    </div>
  );
}

export function SidebarRow({
  icon,
  label,
  trailing,
  active = false,
  indent = false,
  muted = false,
  cursorTarget,
}: {
  readonly icon?: ReactNode;
  readonly label: ReactNode;
  readonly trailing?: ReactNode;
  readonly active?: boolean;
  readonly indent?: boolean;
  readonly muted?: boolean;
  readonly cursorTarget?: string;
}) {
  return (
    <div
      data-cursor-target={cursorTarget}
      className={cx(
        "mx-[6.56px] flex h-[24.6px] min-w-0 shrink-0 items-center gap-[6.56px] rounded-[10.25px] px-[6.56px] [corner-shape:superellipse(1.5)]",
        indent && "pl-[26.24px]",
        active && "bg-app-hover",
        muted ? "text-app-muted" : "text-app-fg/85",
      )}
    >
      {icon ? (
        <span className="flex size-[13.12px] shrink-0 items-center justify-center [&>svg]:size-full">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  );
}

export function SidebarSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="mt-[13.12px] flex flex-col">
      <div className="mx-[6.56px] flex h-[20.5px] items-center px-[6.56px] font-medium text-app-faint">
        {title}
      </div>
      {children}
    </div>
  );
}

export function ProviderMark({
  kind,
  className = "size-3.5",
}: {
  readonly kind: ProviderKind;
  readonly className?: string;
}) {
  if (kind === "claude") return <ClaudeMark className={className} />;
  if (kind === "opencode") return <OpenCodeMark className={className} />;
  return <OpenAIMark className={className} />;
}

/** AgentProviderIcon presentation: provider mark, model and effort. */
export function AgentLabel({
  agent,
  className,
}: {
  readonly agent: AgentChoice;
  readonly className?: string;
}) {
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ProviderMark kind={agent.provider} />
      <span className="truncate">
        {agent.model} · {agent.effort}
      </span>
    </span>
  );
}
