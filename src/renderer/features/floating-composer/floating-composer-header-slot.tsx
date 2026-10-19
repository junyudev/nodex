import { createContext, useContext } from "react";

/**
 * The floating composer's header row. Composer context rails render into it while the composer
 * floats, so their chat and runtime controls sit beside the minimize and move controls.
 */
export const FloatingComposerHeaderSlotContext = createContext<HTMLElement | null>(null);

export function useFloatingComposerHeaderSlot(): HTMLElement | null {
  return useContext(FloatingComposerHeaderSlotContext);
}
