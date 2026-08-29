import type {
  NativeContextMenuItem,
  NativeContextMenuOptions,
} from "../../shared/native-context-menu";

export function canShowNativeContextMenu(): boolean {
  return (
    typeof window !== "undefined" && typeof window.electronBridge?.showContextMenu === "function"
  );
}

export async function showNativeContextMenu(
  items: NativeContextMenuItem[],
  options?: NativeContextMenuOptions,
): Promise<string | null> {
  if (!canShowNativeContextMenu()) {
    throw new Error("Native context menus require Electron");
  }

  if (typeof document !== "undefined" && typeof PointerEvent !== "undefined") {
    document.dispatchEvent(new PointerEvent("pointercancel"));
  }
  return await window.electronBridge!.showContextMenu(items, options);
}
