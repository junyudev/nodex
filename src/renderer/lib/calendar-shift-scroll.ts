export interface ShiftScrollStepInput {
  currentPx: number;
  targetPx: number;
  dayWidthPx: number;
  deltaTimeMs: number;
  isInputIdle: boolean;
  allowNavigation?: boolean;
  snapTriggerFraction?: number;
  followLerpPerFrame?: number;
  idleTargetLerpPerFrame?: number;
  settleEpsilonPx?: number;
}

export interface ShiftScrollStepResult {
  currentPx: number;
  targetPx: number;
  navigateDays: number;
  shouldStop: boolean;
}

const FRAME_MS = 1000 / 60;
const DEFAULT_FOLLOW_LERP = 0.12;
const DEFAULT_IDLE_TARGET_LERP = 0.2;
const DEFAULT_SETTLE_EPSILON_PX = 0.3;
const DEFAULT_SNAP_TRIGGER_FRACTION = 0.5;

function resolveLerpAlpha(lerpPerFrame: number, deltaTimeMs: number): number {
  if (!Number.isFinite(lerpPerFrame)) return 0;
  if (lerpPerFrame <= 0) return 0;
  if (lerpPerFrame >= 1) return 1;

  const normalizedDelta = Number.isFinite(deltaTimeMs) && deltaTimeMs > 0
    ? deltaTimeMs / FRAME_MS
    : 1;

  return 1 - Math.pow(1 - lerpPerFrame, normalizedDelta);
}

export function stepShiftScroll({
  currentPx,
  targetPx,
  dayWidthPx,
  deltaTimeMs,
  isInputIdle,
  allowNavigation = true,
  snapTriggerFraction = DEFAULT_SNAP_TRIGGER_FRACTION,
  followLerpPerFrame = DEFAULT_FOLLOW_LERP,
  idleTargetLerpPerFrame = DEFAULT_IDLE_TARGET_LERP,
  settleEpsilonPx = DEFAULT_SETTLE_EPSILON_PX,
}: ShiftScrollStepInput): ShiftScrollStepResult {
  if (!Number.isFinite(dayWidthPx) || dayWidthPx <= 0) {
    return {
      currentPx: 0,
      targetPx: 0,
      navigateDays: 0,
      shouldStop: true,
    };
  }

  const followAlpha = resolveLerpAlpha(followLerpPerFrame, deltaTimeMs);
  const idleAlpha = resolveLerpAlpha(idleTargetLerpPerFrame, deltaTimeMs);

  let nextTarget = targetPx;
  if (isInputIdle) {
    nextTarget = nextTarget + (0 - nextTarget) * idleAlpha;
  }

  let nextCurrent = currentPx + (nextTarget - currentPx) * followAlpha;
  let navigateDays = 0;

  if (allowNavigation) {
    const clampedFraction = Math.max(0, Math.min(snapTriggerFraction, 1));
    const triggerPx = dayWidthPx * clampedFraction;
    const offsetToFirstTrigger = dayWidthPx - triggerPx;

    if (nextCurrent >= triggerPx) {
      const forwardSteps = Math.floor((nextCurrent + offsetToFirstTrigger) / dayWidthPx);
      navigateDays += forwardSteps;
      nextCurrent -= forwardSteps * dayWidthPx;
      nextTarget -= forwardSteps * dayWidthPx;
    } else if (nextCurrent <= -triggerPx) {
      const backwardSteps = Math.floor(((-nextCurrent) + offsetToFirstTrigger) / dayWidthPx);
      navigateDays -= backwardSteps;
      nextCurrent += backwardSteps * dayWidthPx;
      nextTarget += backwardSteps * dayWidthPx;
    }
  }

  const shouldStop = isInputIdle &&
    Math.abs(nextCurrent) <= settleEpsilonPx &&
    Math.abs(nextTarget) <= settleEpsilonPx;

  if (shouldStop) {
    return {
      currentPx: 0,
      targetPx: 0,
      navigateDays,
      shouldStop: true,
    };
  }

  return {
    currentPx: nextCurrent,
    targetPx: nextTarget,
    navigateDays,
    shouldStop: false,
  };
}
