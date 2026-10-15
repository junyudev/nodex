import { APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS } from "./app-shell-layers";
import { WORKBENCH_SIDEBAR_WIDTH_DEFAULT_PX } from "../../shared/workbench-window-chrome";

export const CODEX_SIDEBAR_WIDTH_DEFAULT_PX = WORKBENCH_SIDEBAR_WIDTH_DEFAULT_PX;
export const CODEX_SIDEBAR_WIDTH_MIN_PX = 240;
export const CODEX_SIDEBAR_WIDTH_MAX_PX = 520;
export const CODEX_SIDEBAR_WIDTH_STORAGE_KEY = "sidebar-width";
export const CODEX_SIDEBAR_COLLAPSE_THRESHOLD_RATIO = 0.5;
export const CODEX_SIDEBAR_COLLAPSE_THRESHOLD_PX =
  CODEX_SIDEBAR_WIDTH_MIN_PX * CODEX_SIDEBAR_COLLAPSE_THRESHOLD_RATIO;

/** Peek presence: a short spring in, a quicker settle out. */
export const CODEX_SIDEBAR_FLOATING_PANEL_TRANSITION = {
  type: "spring",
  duration: 0.3,
  bounce: 0.1,
} as const;

export const CODEX_SIDEBAR_FLOATING_PANEL_EXIT_TRANSITION = {
  type: "spring",
  duration: 0.2,
  bounce: 0.1,
} as const;

export const CODEX_SIDEBAR_FLOATING_OUTER_BASE_CLASS = `pointer-events-auto fixed bottom-2 left-14 ${APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS} min-h-0`;

export const CODEX_SIDEBAR_FLOATING_OUTER_CLASS = `${CODEX_SIDEBAR_FLOATING_OUTER_BASE_CLASS} top-[calc(var(--height-toolbar)+var(--spacing))]`;

export const CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS = `${CODEX_SIDEBAR_FLOATING_OUTER_BASE_CLASS} top-[calc(var(--height-toolbar-sm)+var(--height-toolbar)+var(--spacing))]`;

export const CODEX_SIDEBAR_FLOATING_ASIDE_CLASS =
  "flex h-full min-h-0 flex-col overflow-hidden rounded-(--app-shell-sidebar-popover-radius) bg-(--app-shell-sidebar-popover-background) shadow-[inset_0_0_0_1px_var(--app-shell-sidebar-popover-border),var(--shadow-card)]";

export interface CodexSidebarToggleInput {
  nextOpen: boolean;
  animate?: boolean;
  reducedMotion: boolean | null;
}

export function clampCodexSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return CODEX_SIDEBAR_WIDTH_DEFAULT_PX;
  return Math.min(Math.max(width, CODEX_SIDEBAR_WIDTH_MIN_PX), CODEX_SIDEBAR_WIDTH_MAX_PX);
}

export function shouldCollapseCodexSidebarResizeWidth(width: number): boolean {
  return width < CODEX_SIDEBAR_COLLAPSE_THRESHOLD_PX;
}

export function resolveCodexSidebarWidth(input: {
  layoutSnapshotWidth?: number | null;
  codexStorageWidth?: number | null;
  nodexStorageWidth?: number | null;
}): number {
  if (typeof input.layoutSnapshotWidth === "number") {
    return clampCodexSidebarWidth(input.layoutSnapshotWidth);
  }

  if (typeof input.codexStorageWidth === "number") {
    return clampCodexSidebarWidth(input.codexStorageWidth);
  }

  if (typeof input.nodexStorageWidth === "number") {
    return clampCodexSidebarWidth(input.nodexStorageWidth);
  }

  return CODEX_SIDEBAR_WIDTH_DEFAULT_PX;
}

export function resolveCodexSidebarToggleTargetProgress(nextOpen: boolean): 0 | 1 {
  return nextOpen ? 1 : 0;
}

export function shouldAnimateCodexSidebarToggle({
  animate,
  reducedMotion,
}: Pick<CodexSidebarToggleInput, "animate" | "reducedMotion">): boolean {
  return animate !== false && reducedMotion !== true;
}

export function isCodexSidebarExpandedMounted({
  open,
  progress,
}: {
  open: boolean;
  progress: number;
}): boolean {
  if (open) return true;
  if (!Number.isFinite(progress)) return false;
  return Math.max(0, Math.min(1, progress)) > 0;
}

export function getCodexSidebarFloatingOuterClassName(applicationMenuBarEnabled: boolean): string {
  return applicationMenuBarEnabled
    ? CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS
    : CODEX_SIDEBAR_FLOATING_OUTER_CLASS;
}
