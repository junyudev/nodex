import type { ConversationImageAction } from "@/lib/content-image";
import { toast } from "@/components/ui/toast";
import { canShowNativeContextMenu, showNativeContextMenu } from "@/lib/native-context-menu";

/**
 * Shows an image's actions in the native menu at the pointer and runs the one chosen, while the
 * image is still current. Returns false when no menu shows, so the caller leaves the event alone.
 */
export function showConversationImageMenu(
  actions: readonly ConversationImageAction[],
  point: { readonly x: number; readonly y: number },
  isCurrent: () => boolean,
  beforeRun?: () => void,
): boolean {
  if (actions.length === 0 || !canShowNativeContextMenu()) return false;
  void showNativeContextMenu(
    actions.map(({ id, label }) => ({ id, label })),
    point,
  )
    .then(async (id) => {
      if (!isCurrent()) return;
      beforeRun?.();
      await actions.find((action) => action.id === id)?.run();
    })
    .catch((error: unknown) => {
      if (isCurrent()) toast.danger(error instanceof Error ? error.message : "Image action failed");
    });
  return true;
}
