/** Connected moves preserve native guests; initial attachment still uses append. */
export function moveNativeSubtree(element: HTMLElement, parent: HTMLElement): void {
  if (element.parentElement === parent) return;
  if (element.isConnected && parent.isConnected && typeof parent.moveBefore === "function") {
    parent.moveBefore(element, null);
    return;
  }
  parent.append(element);
}
