import { APP_SHELL_TOOLTIP_LAYER_CLASS } from "./app-shell-layers";

/**
 * A plain-DOM tooltip for ProseMirror decorations, which render outside React. It explains
 * a decorated range while the pointer rests on it or the caret sits inside it.
 */
export interface EditorDecorationTooltip {
  readonly show: (content: string, anchor: Pick<DOMRect, "left" | "bottom">) => void;
  readonly hide: () => void;
  readonly destroy: () => void;
}

export function createEditorDecorationTooltip(input: {
  /** The editor surface that owns the decorated ranges. */
  readonly root: HTMLElement;
  /** Matches a decorated range and reads its explanation. */
  readonly selector: string;
  readonly read: (element: HTMLElement) => string | undefined;
  readonly surfaceClassName: string;
  readonly dataAttribute: string;
}): EditorDecorationTooltip {
  const tooltip = document.createElement("div");
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute(input.dataAttribute, "true");
  tooltip.className = `pointer-events-none fixed hidden max-w-[320px] rounded-md px-2.5 py-1.5 text-xs text-token-text-secondary ${APP_SHELL_TOOLTIP_LAYER_CLASS} ${input.surfaceClassName}`;
  document.body.append(tooltip);
  const show: EditorDecorationTooltip["show"] = (content, anchor) => {
    tooltip.textContent = content;
    tooltip.style.left = `${Math.round(anchor.left)}px`;
    tooltip.style.top = `${Math.round(anchor.bottom + 6)}px`;
    tooltip.classList.remove("hidden");
  };
  const hide = () => tooltip.classList.add("hidden");
  const decorated = (event: Event) =>
    event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(input.selector) : null;
  const onPointerOver = (event: Event) => {
    const target = decorated(event);
    const content = target ? input.read(target) : undefined;
    if (target && content) show(content, target.getBoundingClientRect());
  };
  const onPointerOut = (event: Event) => {
    if (decorated(event)) hide();
  };
  input.root.addEventListener("pointerover", onPointerOver);
  input.root.addEventListener("pointerout", onPointerOut);
  return {
    show,
    hide,
    destroy: () => {
      input.root.removeEventListener("pointerover", onPointerOver);
      input.root.removeEventListener("pointerout", onPointerOut);
      tooltip.remove();
    },
  };
}
