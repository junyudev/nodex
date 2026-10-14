import { APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS } from "./app-shell-layers";

export const CODEX_SIDEBAR_WIDTH_DEFAULT_PX = 300;
export const CODEX_SIDEBAR_WIDTH_MIN_PX = 240;
export const CODEX_SIDEBAR_WIDTH_MAX_PX = 520;
export const CODEX_SIDEBAR_WIDTH_STORAGE_KEY = "sidebar-width";
export const CODEX_SIDEBAR_COLLAPSE_THRESHOLD_RATIO = 0.5;
export const CODEX_SIDEBAR_COLLAPSE_THRESHOLD_PX =
  CODEX_SIDEBAR_WIDTH_MIN_PX * CODEX_SIDEBAR_COLLAPSE_THRESHOLD_RATIO;

export const CODEX_SIDEBAR_EDGE_ENTER_MIN_X_PX = 0;
export const CODEX_SIDEBAR_EDGE_ENTER_MAX_X_PX = 12;

export const CODEX_SIDEBAR_FLOATING_PANEL_TRANSITION = {
  type: "spring",
  duration: 0.5,
  bounce: 0.1,
} as const;

export const CODEX_SIDEBAR_FLOATING_PANEL_REDUCED_MOTION_TRANSITION = {
  duration: 0,
} as const;

export const CODEX_SIDEBAR_FLOATING_OUTER_BASE_CLASS = `pointer-events-auto fixed bottom-1 left-13 ${APP_SHELL_FLOATING_LEFT_PANEL_LAYER_CLASS} min-h-0`;

export const CODEX_SIDEBAR_FLOATING_OUTER_CLASS = `${CODEX_SIDEBAR_FLOATING_OUTER_BASE_CLASS} top-0`;

export const CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS = `${CODEX_SIDEBAR_FLOATING_OUTER_BASE_CLASS} top-(--height-toolbar-sm)`;

export const CODEX_SIDEBAR_FLOATING_ASIDE_CLASS =
  "flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-token-main-surface-primary shadow-[1px_0_0_0_var(--color-token-border-default),0_20px_25px_-5px_rgb(0_0_0/0.1),0_8px_10px_-6px_rgb(0_0_0/0.1)]";

export const CODEX_SIDEBAR_FLOATING_HEADER_CLASS =
  "app-header-tint flex h-toolbar shrink-0 items-center ps-(--spacing-token-safe-header-left) pe-2";

export interface CodexSidebarPointerSnapshot {
  x: number | null;
  y: number | null;
  updatedAt: number | null;
  velocityX: number;
  velocityY: number;
  speed: number;
}

export interface CodexSidebarClientPointerInput {
  clientX: number;
  clientY: number;
  updatedAt: number;
}

export interface CodexSidebarWindowMouseOutInput {
  clientX: number;
  clientY: number;
  innerWidth: number;
  innerHeight: number;
  relatedTarget: EventTarget | null;
}

export const CODEX_SIDEBAR_POINTER_DEFAULT: CodexSidebarPointerSnapshot = {
  x: null,
  y: null,
  updatedAt: null,
  velocityX: 0,
  velocityY: 0,
  speed: 0,
};

export interface CodexSidebarFloatingVisibilityInput {
  pointerX: number | null;
  leftPanelWidthPx: number;
  sidebarOpen: boolean;
  sidebarAnimating: boolean;
  hoverSuppressed: boolean;
  focusOverride: boolean;
  hoverSurfaceActive?: boolean;
  currentlyVisible: boolean;
}

export interface CodexSidebarSuppressionInput {
  pointerX: number | null;
  triggerHovered: boolean;
}

export interface CodexSidebarToggleInput {
  nextOpen: boolean;
  animate?: boolean;
  reducedMotion: boolean | null;
  suppressHoverOpen?: boolean;
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

export function isCodexSidebarEdgeEnterX(x: number | null): boolean {
  return (
    x !== null && x >= CODEX_SIDEBAR_EDGE_ENTER_MIN_X_PX && x <= CODEX_SIDEBAR_EDGE_ENTER_MAX_X_PX
  );
}

export function isCodexSidebarKeepOpenX(x: number | null, leftPanelWidthPx: number): boolean {
  return x !== null && x >= 0 && x <= leftPanelWidthPx;
}

export function shouldClearCodexSidebarHoverSuppression(
  input: CodexSidebarSuppressionInput,
): boolean {
  if (input.triggerHovered) return false;
  if (input.pointerX === null) return false;
  return !isCodexSidebarEdgeEnterX(input.pointerX);
}

export function resolveCodexSidebarToggleTargetProgress(nextOpen: boolean): 0 | 1 {
  return nextOpen ? 1 : 0;
}

export function shouldSuppressCodexSidebarHoverOpen({
  nextOpen,
  suppressHoverOpen,
}: Pick<CodexSidebarToggleInput, "nextOpen" | "suppressHoverOpen">): boolean {
  return !nextOpen && suppressHoverOpen !== false;
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

export function deriveCodexSidebarFloatingVisibility(
  input: CodexSidebarFloatingVisibilityInput,
): boolean {
  if (input.sidebarOpen || input.sidebarAnimating) return false;
  if (input.hoverSuppressed) return false;

  const keepOpen = isCodexSidebarKeepOpenX(input.pointerX, input.leftPanelWidthPx);
  const explicitKeepOpen = input.focusOverride || input.hoverSurfaceActive === true;
  if (input.currentlyVisible) return keepOpen || explicitKeepOpen;

  return isCodexSidebarEdgeEnterX(input.pointerX) || explicitKeepOpen;
}

export function normalizeCodexSidebarPointer(
  input: CodexSidebarClientPointerInput,
  previous: CodexSidebarPointerSnapshot = CODEX_SIDEBAR_POINTER_DEFAULT,
  zoom = 1,
): CodexSidebarPointerSnapshot {
  const normalizedZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = input.clientX / normalizedZoom;
  const y = input.clientY / normalizedZoom;
  const previousX = previous.x;
  const previousY = previous.y;
  const previousUpdatedAt = previous.updatedAt;
  const deltaSeconds =
    previousUpdatedAt !== null ? Math.max((input.updatedAt - previousUpdatedAt) / 1000, 0) : 0;

  if (
    previousX === null ||
    previousY === null ||
    previousUpdatedAt === null ||
    deltaSeconds === 0
  ) {
    return {
      x,
      y,
      updatedAt: input.updatedAt,
      velocityX: 0,
      velocityY: 0,
      speed: 0,
    };
  }

  const velocityX = (x - previousX) / deltaSeconds;
  const velocityY = (y - previousY) / deltaSeconds;
  return {
    x,
    y,
    updatedAt: input.updatedAt,
    velocityX,
    velocityY,
    speed: Math.hypot(velocityX, velocityY),
  };
}

export function shouldResetCodexSidebarPointerOnWindowMouseOut(
  input: CodexSidebarWindowMouseOutInput,
): boolean {
  if (input.relatedTarget !== null) return false;
  return !(
    input.clientX >= 0 &&
    input.clientX < input.innerWidth &&
    input.clientY >= 0 &&
    input.clientY < input.innerHeight
  );
}

export function getCodexSidebarFloatingTransition(reducedMotion: boolean) {
  return reducedMotion
    ? CODEX_SIDEBAR_FLOATING_PANEL_REDUCED_MOTION_TRANSITION
    : CODEX_SIDEBAR_FLOATING_PANEL_TRANSITION;
}

export function getCodexSidebarFloatingOuterClassName(applicationMenuBarEnabled: boolean): string {
  return applicationMenuBarEnabled
    ? CODEX_SIDEBAR_FLOATING_OUTER_APPLICATION_MENU_CLASS
    : CODEX_SIDEBAR_FLOATING_OUTER_CLASS;
}
