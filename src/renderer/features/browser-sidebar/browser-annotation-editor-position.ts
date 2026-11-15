interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the annotation editor sits in the page: beside its target when a side has room, else
 * below, else above, so the target stays visible while it is written about. A page too small
 * for any of them gets the editor clamped inside it.
 */
export function placeBrowserAnnotationEditor(
  anchor: Box,
  page: { width: number; height: number },
  editor: { width: number; height: number },
) {
  const gap = 8;
  const clamp = (value: number, extent: number, size: number) =>
    Math.max(gap, Math.min(value, extent - size - gap));
  const right = anchor.x + anchor.width + gap;
  const left = anchor.x - editor.width - gap;
  const below = anchor.y + anchor.height + gap;
  const above = anchor.y - editor.height - gap;
  const beside = right + editor.width <= page.width - gap ? right : left >= gap ? left : undefined;
  const position =
    beside !== undefined
      ? { left: beside, top: anchor.y }
      : {
          left: anchor.x,
          top: below + editor.height <= page.height - gap || above < gap ? below : above,
        };
  return {
    left: clamp(position.left, page.width, editor.width),
    top: clamp(position.top, page.height, editor.height),
    maxWidth: Math.max(0, page.width - gap * 2),
    maxHeight: Math.max(0, page.height - gap * 2),
  };
}
