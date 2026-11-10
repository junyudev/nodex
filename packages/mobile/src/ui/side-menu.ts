/** How wide the menu opens: most of the screen, leaving the app in sight to return to. */
export const sideMenuWidth = (screenWidth: number): number =>
  Math.round(Math.min(screenWidth * 0.8, 340));

/** How fast, in points a second, a release counts as a flick towards one side. */
const FLICK = 500;

/**
 * Where a released drag comes to rest. A flick decides it whichever side is nearer, so a short
 * quick swipe is enough; a slow release settles on the nearer side.
 */
export const restsOpen = (progress: number, velocityX: number): boolean => {
  "worklet";
  if (Math.abs(velocityX) > FLICK) return velocityX > 0;
  return progress > 0.5;
};

/** How open the menu is as a drag moves it, starting from where the drag found it. */
export const draggedProgress = (start: number, translationX: number, menuWidth: number): number => {
  "worklet";
  return Math.min(1, Math.max(0, start + translationX / menuWidth));
};
