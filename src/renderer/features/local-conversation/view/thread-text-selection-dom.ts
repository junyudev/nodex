import type { ResponseTextAnnotation } from "../../../../shared/thread-text-selection";

export const THREAD_SELECTED_TEXT_TARGET_SELECTOR = '[data-thread-selected-text-target="true"]';
export const RESPONSE_ANNOTATION_TARGET_ATTRIBUTE = "data-response-annotation-target";

export interface SelectedTextRectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

function nodeElement(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

function resolveEndpoint(node: Node | null, offset: number, selector: string): HTMLElement | null {
  const element = nodeElement(node);
  if (element?.closest('[contenteditable="true"], input, textarea')) return null;
  const target = element?.closest<HTMLElement>(selector);
  if (target) return target;
  if (!(node instanceof Element)) return null;
  for (const child of [node.childNodes[offset], node.childNodes[offset - 1]]) {
    const adjacent = nodeElement(child ?? null)?.closest<HTMLElement>(selector);
    if (adjacent) return adjacent;
  }
  return null;
}

export function resolveCommonSelectedTextTarget(input: {
  rootElement: HTMLElement;
  anchorNode: Node | null;
  focusNode: Node | null;
  anchorOffset?: number;
  focusOffset?: number;
  targetSelector?: string;
}): HTMLElement | null {
  if (
    [input.anchorNode, input.focusNode].some((node) =>
      nodeElement(node)?.closest('[contenteditable="true"], input, textarea'),
    )
  )
    return null;
  const selector = input.targetSelector ?? THREAD_SELECTED_TEXT_TARGET_SELECTOR;
  const anchor = resolveEndpoint(input.anchorNode, input.anchorOffset ?? 0, selector);
  const focus = resolveEndpoint(input.focusNode, input.focusOffset ?? 0, selector);
  if (anchor && focus && anchor !== focus) return null;
  const target = anchor ?? focus;
  return target && input.rootElement.contains(target) ? target : null;
}

export function clampSelectionRange(range: Range, target: HTMLElement): Range {
  const bounds = document.createRange();
  bounds.selectNodeContents(target);
  const result = range.cloneRange();
  if (
    !target.contains(result.startContainer) ||
    result.compareBoundaryPoints(Range.START_TO_START, bounds) < 0
  )
    result.setStart(bounds.startContainer, bounds.startOffset);
  if (
    !target.contains(result.endContainer) ||
    result.compareBoundaryPoints(Range.END_TO_END, bounds) > 0
  )
    result.setEnd(bounds.endContainer, bounds.endOffset);
  return result;
}

export function intersectSelectionRect(
  rect: SelectedTextRectLike,
  bounds: SelectedTextRectLike,
): DOMRect | null {
  const left = Math.max(rect.left, bounds.left);
  const top = Math.max(rect.top, bounds.top);
  const right = Math.min(rect.right, bounds.right);
  const bottom = Math.min(rect.bottom, bounds.bottom);
  return left < right && top < bottom ? new DOMRect(left, top, right - left, bottom - top) : null;
}

/** Clip through every scroll owner, including nested code blocks and the sticky composer. */
export function readSelectionVisibleBounds(
  element: HTMLElement,
  footerTop?: number,
): DOMRect | null {
  let bounds = new DOMRect(
    0,
    0,
    window.innerWidth,
    Math.min(window.innerHeight, footerTop ?? window.innerHeight),
  );
  let current: HTMLElement | null = element;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = getComputedStyle(current);
    const clipsX = /auto|clip|hidden|overlay|scroll/u.test(style.overflowX || style.overflow);
    const clipsY = /auto|clip|hidden|overlay|scroll/u.test(style.overflowY || style.overflow);
    const rect = current.getBoundingClientRect();
    const clipped = intersectSelectionRect(bounds, {
      left: clipsX ? rect.left : bounds.left,
      right: clipsX ? rect.right : bounds.right,
      top: clipsY ? rect.top : bounds.top,
      bottom: clipsY ? rect.bottom : bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    });
    if (!clipped) return null;
    bounds = clipped;
    current = current.parentElement;
  }
  return bounds;
}

export function readVisibleSelectionRect(
  range: Range,
  target: HTMLElement,
  footerTop?: number,
): DOMRect | null {
  const bounds = readSelectionVisibleBounds(target, footerTop);
  if (!bounds) return null;
  const rects = [...range.getClientRects()];
  for (const rect of rects) {
    const visible = intersectSelectionRect(rect, bounds);
    if (visible) return visible;
  }
  const rect = range.getBoundingClientRect();
  const visible = intersectSelectionRect(rect, bounds);
  if (visible) return visible;
  if (
    rects.some((entry) => entry.width > 0 && entry.height > 0) ||
    (rect.width > 0 && rect.height > 0)
  )
    return null;
  return intersectSelectionRect(target.getBoundingClientRect(), bounds);
}

function textOffset(target: HTMLElement, node: Node, offset: number): number {
  const prefix = document.createRange();
  prefix.selectNodeContents(target);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}

export function createResponseTextAnnotation(
  target: HTMLElement,
  range: Range,
  text: string,
): ResponseTextAnnotation | null {
  const messageId = target.getAttribute(RESPONSE_ANNOTATION_TARGET_ATTRIBUTE);
  const threadId = target.getAttribute("data-response-annotation-thread");
  if (!messageId || !threadId) return null;
  return {
    id: crypto.randomUUID(),
    text,
    source: {
      threadId,
      messageId,
      startOffset: textOffset(target, range.startContainer, range.startOffset),
      endOffset: textOffset(target, range.endContainer, range.endOffset),
      rangeText: range.toString(),
    },
  };
}

/** Exact offsets and captured text prevent a repeated phrase from targeting another occurrence. */
export function resolveResponseAnnotationRange(
  root: HTMLElement,
  annotation: ResponseTextAnnotation,
): Range | null {
  const target = [
    ...root.querySelectorAll<HTMLElement>(`[${RESPONSE_ANNOTATION_TARGET_ATTRIBUTE}]`),
  ].find(
    (element) =>
      element.getAttribute(RESPONSE_ANNOTATION_TARGET_ATTRIBUTE) === annotation.source.messageId &&
      element.getAttribute("data-response-annotation-thread") === annotation.source.threadId,
  );
  if (!target) return null;
  const { startOffset, endOffset, rangeText } = annotation.source;
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  let node = walker.nextNode();
  while (node) {
    const nextOffset = offset + (node.textContent?.length ?? 0);
    if (!started && startOffset <= nextOffset) {
      range.setStart(node, startOffset - offset);
      started = true;
    }
    if (started && endOffset <= nextOffset) {
      range.setEnd(node, endOffset - offset);
      return range.toString() === rangeText ? range : null;
    }
    offset = nextOffset;
    node = walker.nextNode();
  }
  return null;
}
