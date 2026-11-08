import type { FileTree as PierreFileTreeModel } from "@pierre/trees";

const ATTEMPTS = 60;

/**
 * Hands `attach` the element matching `selector` in the tree's shadow root once the tree has
 * rendered it, retrying for about a second; returns a canceller that also runs `attach`'s cleanup.
 */
export function withFileTreeElement(
  model: PierreFileTreeModel,
  selector: string,
  attach: (element: HTMLElement) => (() => void) | void,
) {
  let frame: number | null = null;
  let release: (() => void) | void;
  const attempt = (remaining: number) => {
    frame = null;
    const element = model.getFileTreeContainer()?.shadowRoot?.querySelector<HTMLElement>(selector);
    if (element) release = attach(element);
    else if (remaining > 0) frame = requestAnimationFrame(() => attempt(remaining - 1));
  };
  attempt(ATTEMPTS);
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    release?.();
  };
}
