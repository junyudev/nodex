export const APP_SHELL_TAB_GAP_PX = 3;
export const APP_SHELL_TAB_MIN_WIDTH_PX = 90;
export const APP_SHELL_TAB_MAX_WIDTH_PX = 160;

export interface AppShellTabFlexSizing {
  flexBasis: number;
  flexGrow: number;
}

export function buildAppShellTabListWidth({
  tabCount,
  trailingWidthPx,
  lockedWidthPx,
}: {
  tabCount: number;
  trailingWidthPx: number;
  lockedWidthPx: number | null;
}): string {
  const count = normalizeTabCount(tabCount);
  if (count === 0) return "0px";

  const gapWidthPx = Math.max(0, count - 1) * APP_SHELL_TAB_GAP_PX;
  const normalizedLockedWidthPx = normalizePositiveWidth(lockedWidthPx);
  if (normalizedLockedWidthPx !== null) {
    return `${count * normalizedLockedWidthPx + gapWidthPx}px`;
  }

  const minimumWidthPx = count * APP_SHELL_TAB_MIN_WIDTH_PX + gapWidthPx;
  const maximumWidthPx = count * APP_SHELL_TAB_MAX_WIDTH_PX + gapWidthPx;
  const normalizedTrailingWidthPx = normalizeNonNegativeWidth(trailingWidthPx);
  return `clamp(${minimumWidthPx}px, calc(100cqw - ${normalizedTrailingWidthPx}px), ${maximumWidthPx}px)`;
}

export function buildAppShellTabFlexSizing(lockedWidthPx: number | null): AppShellTabFlexSizing {
  const normalizedLockedWidthPx = normalizePositiveWidth(lockedWidthPx);
  if (normalizedLockedWidthPx === null) {
    return {
      flexBasis: 0,
      flexGrow: 1,
    };
  }

  return {
    flexBasis: normalizedLockedWidthPx,
    flexGrow: 0,
  };
}

function normalizeTabCount(tabCount: number): number {
  if (!Number.isFinite(tabCount)) return 0;
  return Math.max(0, Math.floor(tabCount));
}

function normalizePositiveWidth(widthPx: number | null): number | null {
  if (widthPx === null) return null;
  if (!Number.isFinite(widthPx)) return null;
  if (widthPx <= 0) return null;
  return Math.round(widthPx);
}

function normalizeNonNegativeWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return 0;
  return Math.max(0, Math.round(widthPx));
}
