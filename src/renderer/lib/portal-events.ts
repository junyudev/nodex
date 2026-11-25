import type { SyntheticEvent } from "react";

/**
 * Whether a React event reached an element from a menu, dialog or popover it rendered into a
 * portal, rather than from its own part of the page. React passes a portal's events up the
 * component tree, so an element that acts on clicks, keys, right-clicks or drags would otherwise
 * also act on a choice made inside its own menu.
 */
export function cameThroughPortal(event: SyntheticEvent): boolean {
  const target = event.target;
  return target instanceof Node && !event.currentTarget.contains(target);
}
