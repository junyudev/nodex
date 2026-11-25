const BROWSER_IMAGE_DRAG_TYPE_PREFIX = "application/x-nodex-browser-image-drag-";
export const BROWSER_IMAGE_DRAG_TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

export function browserImageDragType(dragToken: string): string {
  return BROWSER_IMAGE_DRAG_TYPE_PREFIX + dragToken;
}

/** Drag events before drop expose the type names, but protect the payload. */
export function readBrowserImageDragToken(types: readonly string[]): string | null {
  for (const type of types) {
    if (!type.startsWith(BROWSER_IMAGE_DRAG_TYPE_PREFIX)) continue;
    const token = type.slice(BROWSER_IMAGE_DRAG_TYPE_PREFIX.length);
    if (BROWSER_IMAGE_DRAG_TOKEN_PATTERN.test(token)) return token;
  }
  return null;
}
