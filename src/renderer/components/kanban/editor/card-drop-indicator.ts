import type { CardDropIndicatorPosition } from "./card-drop-insert";

const INDICATOR_SELECTOR = "[data-card-drop-indicator]";

function getIndicator(container: HTMLElement): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>(INDICATOR_SELECTOR);
}

function ensureIndicator(container: HTMLElement): HTMLDivElement {
  const existing = getIndicator(container);
  if (existing) return existing;

  const indicator = container.ownerDocument.createElement("div");
  indicator.setAttribute("data-card-drop-indicator", "");
  indicator.setAttribute("aria-hidden", "true");
  container.appendChild(indicator);
  return indicator;
}

export function clearCardDropIndicator(container: HTMLElement): void {
  getIndicator(container)?.remove();
}

export function renderCardDropIndicator(
  container: HTMLElement,
  position: CardDropIndicatorPosition | null,
): void {
  if (!position) {
    clearCardDropIndicator(container);
    return;
  }

  const indicator = ensureIndicator(container);
  indicator.style.top = `${position.top}px`;
  indicator.style.left = `${position.left}px`;
  indicator.style.width = `${position.width}px`;
}
