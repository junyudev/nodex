/**
 * Whether a React event started inside the element whose handler sees it.
 *
 * React bubbles events along the component tree, so focus, pointer and key input inside a
 * portalled menu, popover or dialog reaches every component that rendered it even though its
 * DOM target lives elsewhere. A handler that tracks where the person is working ignores input
 * that only passed through this way: hovering a menu row moves focus, but it does not move the
 * person into the surface that opened the menu.
 */
export function isEventWithinCurrentTarget(event: {
  readonly currentTarget: EventTarget | null;
  readonly target: EventTarget | null;
}): boolean {
  const { currentTarget, target } = event;
  return currentTarget instanceof Node && target instanceof Node && currentTarget.contains(target);
}
