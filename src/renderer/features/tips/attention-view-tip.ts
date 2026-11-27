import { useEffect } from "react";
import type { SidebarOrganize } from "@/lib/sidebar-chat-lifecycle";
import { useTipsState } from "./tips-state";

/** Attention view's tip while it may still be said. */
export interface AttentionViewTip {
  /** Puts the tip away for good. */
  readonly dismiss: () => void;
}

/**
 * The tip that introduces Attention view, while the sidebar keeps chats under their Projects.
 * Turning the view on answers it, whichever way it is turned on: a person who found the view needs
 * no introduction, so a view in use settles its tip unseen. `organize` is null where the window
 * shows no sidebar, which neither says the tip nor settles it.
 */
export function useAttentionViewTip(organize: SidebarOrganize | null): AttentionViewTip | null {
  const { state, settle } = useTipsState();
  const unsettled = state !== null && !state.settled.includes("attention-view");
  const inUse = organize === "attention";
  useEffect(() => {
    if (unsettled && inUse) settle("attention-view");
  }, [inUse, settle, unsettled]);
  if (!unsettled || !state.on || organize !== "project") return null;
  return { dismiss: () => settle("attention-view") };
}
