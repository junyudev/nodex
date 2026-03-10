export interface StageWheelNavigationInput {
  deltaPx: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  nowMs: number;
  lastStepAtMs: number;
  cooldownMs?: number;
  minDeltaPx?: number;
}

export interface StageShiftWheelNestedScrollInput {
  target: EventTarget | null;
  stopAt: HTMLElement | null;
  direction: -1 | 1;
}

export interface StageRailCalendarWheelGuardInput {
  target: EventTarget | null;
  shiftKey: boolean;
  ctrlKey: boolean;
}

export interface StageWheelNavigationResult {
  consumeEvent: boolean;
  direction: -1 | 0 | 1;
  nextStepAtMs: number;
}

export const CALENDAR_SHIFT_WHEEL_SCOPE_ATTR = "data-calendar-shift-wheel-scope";
export const CALENDAR_SHIFT_WHEEL_SCOPE_VALUE = "calendar";

const DEFAULT_STAGE_WHEEL_COOLDOWN_MS = 150;
const DEFAULT_STAGE_WHEEL_MIN_DELTA_PX = 2;
const SCROLL_EPSILON_PX = 1;
const SCROLLABLE_OVERFLOW_PATTERN = /(auto|scroll|overlay)/;

function resolveEventTargetElement(target: EventTarget | null): HTMLElement | null {
  if (!target) return null;

  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    return target;
  }

  if (typeof Node !== "undefined" && target instanceof Node) {
    return target.parentElement;
  }

  if (typeof target === "object" && target !== null && "parentElement" in target) {
    return (target as { parentElement?: HTMLElement | null }).parentElement ?? null;
  }

  return null;
}

function isHorizontallyScrollable(node: HTMLElement): boolean {
  const ownerWindow = node.ownerDocument.defaultView;
  if (!ownerWindow) return false;

  const style = ownerWindow.getComputedStyle(node);
  const overflowX = style.overflowX === "visible"
    ? style.overflow
    : style.overflowX;

  if (!SCROLLABLE_OVERFLOW_PATTERN.test(overflowX)) return false;
  return node.scrollWidth - node.clientWidth > SCROLL_EPSILON_PX;
}

function canScrollHorizontallyInDirection(
  node: HTMLElement,
  direction: -1 | 1,
): boolean {
  const maxScrollLeft = node.scrollWidth - node.clientWidth;
  if (maxScrollLeft <= SCROLL_EPSILON_PX) return false;

  if (direction > 0) {
    return node.scrollLeft < maxScrollLeft - SCROLL_EPSILON_PX;
  }

  return node.scrollLeft > SCROLL_EPSILON_PX;
}

export function shouldDeferStageShiftWheelToNestedScroll({
  target,
  stopAt,
  direction,
}: StageShiftWheelNestedScrollInput): boolean {
  const start = resolveEventTargetElement(target);
  if (!start || !stopAt) return false;

  let node: HTMLElement | null = start;
  while (node && node !== stopAt) {
    if (
      isHorizontallyScrollable(node)
      && canScrollHorizontallyInDirection(node, direction)
    ) {
      return true;
    }
    node = node.parentElement;
  }

  return false;
}

export function isInsideCalendarShiftWheelScope(target: EventTarget | null): boolean {
  const start = resolveEventTargetElement(target);
  if (!start) return false;

  let node: HTMLElement | null = start;
  while (node) {
    const scope = node.getAttribute?.(CALENDAR_SHIFT_WHEEL_SCOPE_ATTR);
    if (scope === CALENDAR_SHIFT_WHEEL_SCOPE_VALUE) return true;
    node = node.parentElement;
  }

  return false;
}

export function shouldPreventStageRailShiftWheelFromCalendar({
  target,
  shiftKey,
  ctrlKey,
}: StageRailCalendarWheelGuardInput): boolean {
  if (!shiftKey || ctrlKey) return false;
  return isInsideCalendarShiftWheelScope(target);
}

export function resolveWrappedStageIndex(
  currentIndex: number,
  direction: -1 | 1,
  stageCount: number,
): number {
  if (!Number.isInteger(stageCount) || stageCount <= 0) return 0;

  const normalizedCurrent = ((currentIndex % stageCount) + stageCount) % stageCount;
  if (direction > 0) return (normalizedCurrent + 1) % stageCount;
  return (normalizedCurrent - 1 + stageCount) % stageCount;
}

export function resolveStageWheelNavigation({
  deltaPx,
  shiftKey,
  ctrlKey,
  nowMs,
  lastStepAtMs,
  cooldownMs = DEFAULT_STAGE_WHEEL_COOLDOWN_MS,
  minDeltaPx = DEFAULT_STAGE_WHEEL_MIN_DELTA_PX,
}: StageWheelNavigationInput): StageWheelNavigationResult {
  if (!shiftKey || ctrlKey) {
    return {
      consumeEvent: false,
      direction: 0,
      nextStepAtMs: lastStepAtMs,
    };
  }

  if (!Number.isFinite(deltaPx) || deltaPx === 0) {
    return {
      consumeEvent: false,
      direction: 0,
      nextStepAtMs: lastStepAtMs,
    };
  }

  if (Math.abs(deltaPx) < Math.max(0, minDeltaPx)) {
    return {
      consumeEvent: true,
      direction: 0,
      nextStepAtMs: lastStepAtMs,
    };
  }

  if (nowMs - lastStepAtMs < Math.max(0, cooldownMs)) {
    return {
      consumeEvent: true,
      direction: 0,
      nextStepAtMs: lastStepAtMs,
    };
  }

  return {
    consumeEvent: true,
    direction: deltaPx > 0 ? 1 : -1,
    nextStepAtMs: nowMs,
  };
}
