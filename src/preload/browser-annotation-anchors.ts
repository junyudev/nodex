import type {
  BrowserAnnotationAnchor,
  BrowserAnnotationTextLocator,
  BrowserAnnotationScrollContainer,
} from "../shared/browser-annotation";

const textOf = (element: Element) =>
  element.textContent?.replace(/\s+/g, " ").trim().slice(0, 2048);
const escapeId = (id: string) =>
  typeof CSS !== "undefined"
    ? CSS.escape(id)
    : id.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
function localSelector(element: Element): string {
  if (element.id) return `#${escapeId(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current) {
    const tag = current.localName;
    const parent: Element | null = current.parentElement;
    const siblings = parent
      ? Array.from(parent.children).filter((child) => child.localName === tag)
      : [];
    parts.unshift(
      `${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ""}`,
    );
    current = parent;
  }
  return parts.join(" > ");
}
export function browserAnnotationElementAddress(element: Element): {
  selector: string;
  shadowHosts: string[];
} {
  const selector = localSelector(element);
  const shadowHosts: string[] = [];
  let root = element.getRootNode();
  while ("host" in root) {
    const host = (root as ShadowRoot).host;
    shadowHosts.unshift(localSelector(host));
    root = host.getRootNode();
  }
  return { selector, shadowHosts };
}
function resolveAnnotationScope(
  root: Document | ShadowRoot,
  shadowHosts: readonly string[],
): Document | ShadowRoot | null {
  let scope = root;
  for (const host of shadowHosts) {
    const shadow = scope.querySelector(host)?.shadowRoot;
    if (!shadow) return null;
    scope = shadow;
  }
  return scope;
}
export function resolveBrowserAnnotationSelector(
  root: Document | ShadowRoot,
  selector: string,
  shadowHosts: readonly string[] = [],
): Element | null {
  try {
    return resolveAnnotationScope(root, shadowHosts)?.querySelector(selector) ?? null;
  } catch {
    return null;
  }
}
const encodedAddress = (element: Element) => {
  const address = browserAnnotationElementAddress(element);
  return [...address.shadowHosts, address.selector].join(" >>> ");
};
export function resolveBrowserAnnotationFrame(
  root: Document,
  framePath: readonly string[],
): Document | null {
  let document = root;
  for (const path of framePath) {
    const selectors = path.split(" >>> ");
    const selector = selectors.pop();
    if (!selector) return null;
    const frame = resolveBrowserAnnotationSelector(
      document,
      selector,
      selectors,
    ) as HTMLIFrameElement | null;
    try {
      if (!frame?.contentDocument) return null;
      document = frame.contentDocument;
    } catch {
      return null;
    }
  }
  return document;
}
function frameContext(document: Document): {
  framePath: string[];
  offset: { x: number; y: number };
  scale: { x: number; y: number };
} {
  const framePath: string[] = [];
  const offset = { x: 0, y: 0 };
  const scale = { x: 1, y: 1 };
  let view = document.defaultView;
  while (view?.frameElement) {
    const frame = view.frameElement as HTMLElement;
    const rect = frame.getBoundingClientRect();
    framePath.unshift(encodedAddress(frame));
    const factor = {
      x: frame.offsetWidth ? rect.width / frame.offsetWidth : 1,
      y: frame.offsetHeight ? rect.height / frame.offsetHeight : 1,
    };
    offset.x = rect.left + frame.clientLeft * factor.x + offset.x * factor.x;
    offset.y = rect.top + frame.clientTop * factor.y + offset.y * factor.y;
    scale.x *= factor.x;
    scale.y *= factor.y;
    view = frame.ownerDocument.defaultView;
  }
  return { framePath, offset, scale };
}
/** Descends through open shadow roots and same-origin frames. Cross-origin frames stay opaque. */
export function hitTestBrowserAnnotation(document: Document, x: number, y: number): Element | null {
  let element = document.elementFromPoint?.(x, y) ?? null;
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint?.(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element?.localName !== "iframe") return element;
  try {
    const frame = element as HTMLIFrameElement;
    const child = frame.contentDocument;
    const rect = frame.getBoundingClientRect();
    return child
      ? (hitTestBrowserAnnotation(
          child,
          (x - rect.left) / (frame.offsetWidth ? rect.width / frame.offsetWidth : 1) -
            frame.clientLeft,
          (y - rect.top) / (frame.offsetHeight ? rect.height / frame.offsetHeight : 1) -
            frame.clientTop,
        ) ?? element)
      : element;
  } catch {
    return element;
  }
}
function composedParent(element: Element): Element | null {
  return (
    element.parentElement ??
    ("host" in element.getRootNode() ? (element.getRootNode() as ShadowRoot).host : null)
  );
}
function scrollFacts(element: Element): {
  isFixed: boolean;
  scrollContainers: BrowserAnnotationScrollContainer[];
} {
  const scrollContainers: BrowserAnnotationScrollContainer[] = [];
  let current: Element | null = element;
  let isFixed = false;
  while (current) {
    if (current.ownerDocument.defaultView?.getComputedStyle(current).position === "fixed")
      isFixed = true;
    if (
      current !== element.ownerDocument.scrollingElement &&
      (current.scrollHeight > current.clientHeight || current.scrollWidth > current.clientWidth)
    ) {
      scrollContainers.push({
        ...browserAnnotationElementAddress(current),
        scrollLeft: current.scrollLeft,
        scrollTop: current.scrollTop,
      });
    }
    current = composedParent(current);
  }
  return { isFixed, scrollContainers: scrollContainers.slice(0, 32) };
}
export function captureBrowserAnnotationTextLocator(
  selection: Selection,
  range?: Range,
): BrowserAnnotationTextLocator | null {
  const selectedRange = range ?? (selection.rangeCount ? selection.getRangeAt(0) : null);
  if (!selectedRange || selectedRange.collapsed) return null;
  const common = selectedRange.commonAncestorContainer;
  const base =
    common.nodeType === 11 && "host" in common
      ? (common as ShadowRoot)
      : common.nodeType === 1
        ? (common as Element)
        : common.parentElement;
  if (!base) return null;
  const address =
    "host" in base
      ? browserAnnotationElementAddress(base.host)
      : browserAnnotationElementAddress(base);
  const locatorAddress =
    "host" in base
      ? { selector: "", shadowHosts: [...address.shadowHosts, address.selector] }
      : address;
  const prefix = base.ownerDocument.createRange();
  prefix.selectNodeContents(base);
  prefix.setEnd(selectedRange.startContainer, selectedRange.startOffset);
  const startOffset = prefix.toString().length;
  const direction =
    selection.direction === "backward" ||
    (selection.anchorNode === selectedRange.endContainer &&
      selection.anchorOffset === selectedRange.endOffset)
      ? "backward"
      : "forward";
  return {
    kind: "dom",
    ...locatorAddress,
    startOffset,
    endOffset: startOffset + selectedRange.toString().length,
    direction,
    rangeText: selectedRange.toString().slice(0, 2048),
  };
}
/** UTF-16 offsets use DOM Range's own convention and refuse a changed text quote. */
export function restoreBrowserAnnotationTextLocator(
  document: Document,
  locator: BrowserAnnotationTextLocator,
): Range | null {
  const element = locator.selector
    ? resolveBrowserAnnotationSelector(document, locator.selector, locator.shadowHosts)
    : resolveAnnotationScope(document, locator.shadowHosts);
  if (!element || locator.kind !== "dom") return null;
  const walker = document.createTreeWalker(element, 4);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const end = offset + (node.textContent?.length ?? 0);
    if (!started && locator.startOffset <= end) {
      range.setStart(node, locator.startOffset - offset);
      started = true;
    }
    if (started && locator.endOffset <= end) {
      range.setEnd(node, locator.endOffset - offset);
      return range.toString().slice(0, 2048) === locator.rangeText ? range : null;
    }
    offset = end;
  }
  return null;
}
function topRect(
  rect: Pick<DOMRect, "x" | "y" | "width" | "height">,
  offset: { x: number; y: number },
  scale = { x: 1, y: 1 },
) {
  return {
    x: rect.x * scale.x + offset.x,
    y: rect.y * scale.y + offset.y,
    width: rect.width * scale.x,
    height: rect.height * scale.y,
  };
}
export function captureBrowserAnnotationAnchor(
  element: Element,
  id: string,
  page: Window,
  region?: BrowserAnnotationAnchor["rect"],
): BrowserAnnotationAnchor {
  const document = element.ownerDocument;
  const view = document.defaultView!;
  const context = frameContext(document);
  const selection = document.getSelection();
  const shadowRoots: ShadowRoot[] = [];
  let root = element.getRootNode();
  while ("host" in root) {
    shadowRoots.push(root as ShadowRoot);
    root = (root as ShadowRoot).host.getRootNode();
  }
  let selectionRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (selection && shadowRoots.length && "getComposedRanges" in selection) {
    const composed = selection.getComposedRanges({ shadowRoots })[0];
    if (composed && composed.startContainer.getRootNode() === composed.endContainer.getRootNode()) {
      selectionRange = document.createRange();
      selectionRange.setStart(composed.startContainer, composed.startOffset);
      selectionRange.setEnd(composed.endContainer, composed.endOffset);
    }
  }
  let locator =
    !region && selection && selectionRange
      ? captureBrowserAnnotationTextLocator(selection, selectionRange)
      : null;
  const control = element as HTMLInputElement | HTMLTextAreaElement;
  if (
    !region &&
    /^(input|textarea)$/.test(element.localName) &&
    control.type !== "password" &&
    control.selectionStart !== null &&
    control.selectionEnd !== null &&
    control.selectionStart !== control.selectionEnd
  ) {
    locator = {
      kind: "form-control",
      ...browserAnnotationElementAddress(element),
      startOffset: control.selectionStart,
      endOffset: control.selectionEnd,
      direction: control.selectionDirection === "backward" ? "backward" : "forward",
      rangeText: control.value.slice(control.selectionStart, control.selectionEnd).slice(0, 2048),
    };
  }
  const range = locator?.kind === "dom" ? selectionRange : null;
  const rect = region ?? range?.getBoundingClientRect() ?? element.getBoundingClientRect();
  const styles = view.getComputedStyle(element);
  return {
    id,
    kind: region ? "region" : locator ? "text" : "element",
    pageUrl: page.location.href,
    frameUrl: view.location.href,
    framePath: context.framePath,
    frameOffset: context.offset,
    frameScale: context.scale,
    ...browserAnnotationElementAddress(element),
    elementPath: encodedAddress(element),
    ...scrollFacts(element),
    documentScroll: { x: view.scrollX, y: view.scrollY },
    ...(locator ? { textLocator: locator, selectedText: locator.rangeText } : {}),
    textExcerpt: locator?.rangeText ?? textOf(element),
    nearbyText: textOf(element.parentElement ?? element),
    role:
      element.getAttribute("role") ??
      { button: "button", a: "link", input: "textbox", textarea: "textbox" }[element.localName] ??
      element.localName,
    name: (
      element.getAttribute("aria-label") ??
      element.getAttribute("title") ??
      textOf(element) ??
      ""
    ).slice(0, 2048),
    computedStyle: {
      color: styles.color,
      backgroundColor: styles.backgroundColor,
      fontSize: styles.fontSize,
      borderRadius: styles.borderRadius,
      opacity: styles.opacity,
    },
    viewportSize: { width: page.innerWidth, height: page.innerHeight },
    rect: topRect(rect, context.offset, context.scale),
  };
}
export function resolveBrowserAnnotationAnchor(
  document: Document,
  anchor: BrowserAnnotationAnchor,
): BrowserAnnotationAnchor | null {
  const frame = resolveBrowserAnnotationFrame(document, anchor.framePath ?? []);
  const view = frame?.defaultView;
  if (!frame || !view) return null;
  const { offset, scale } = frameContext(frame);
  if (anchor.kind === "region") {
    const delta = anchor.isFixed
      ? { x: 0, y: 0 }
      : (anchor.scrollContainers ?? []).reduce(
          (sum, entry) => {
            const element = resolveBrowserAnnotationSelector(
              frame,
              entry.selector,
              entry.shadowHosts,
            );
            return {
              x: sum.x + entry.scrollLeft - (element?.scrollLeft ?? entry.scrollLeft),
              y: sum.y + entry.scrollTop - (element?.scrollTop ?? entry.scrollTop),
            };
          },
          {
            x: (anchor.documentScroll?.x ?? view.scrollX) - view.scrollX,
            y: (anchor.documentScroll?.y ?? view.scrollY) - view.scrollY,
          },
        );
    return {
      ...anchor,
      viewportSize: {
        width: document.defaultView!.innerWidth,
        height: document.defaultView!.innerHeight,
      },
      rect: {
        ...anchor.rect,
        x:
          offset.x +
          ((anchor.rect.x - (anchor.frameOffset?.x ?? offset.x)) * scale.x) /
            (anchor.frameScale?.x ?? scale.x) +
          delta.x * scale.x,
        y:
          offset.y +
          ((anchor.rect.y - (anchor.frameOffset?.y ?? offset.y)) * scale.y) /
            (anchor.frameScale?.y ?? scale.y) +
          delta.y * scale.y,
        width: (anchor.rect.width * scale.x) / (anchor.frameScale?.x ?? scale.x),
        height: (anchor.rect.height * scale.y) / (anchor.frameScale?.y ?? scale.y),
      },
    };
  }
  const element = anchor.selector
    ? resolveBrowserAnnotationSelector(frame, anchor.selector, anchor.shadowHosts)
    : null;
  const range = anchor.textLocator
    ? restoreBrowserAnnotationTextLocator(frame, anchor.textLocator)
    : null;
  if (anchor.textLocator?.kind === "dom" && !range) return null;
  if (!element) return null;
  if (anchor.textLocator?.kind === "form-control") {
    const control = element as HTMLInputElement;
    if (
      control.value
        .slice(anchor.textLocator.startOffset, anchor.textLocator.endOffset)
        .slice(0, 2048) !== anchor.textLocator.rangeText
    )
      return null;
  }
  return {
    ...anchor,
    viewportSize: {
      width: document.defaultView!.innerWidth,
      height: document.defaultView!.innerHeight,
    },
    rect: topRect(range?.getBoundingClientRect() ?? element.getBoundingClientRect(), offset, scale),
  };
}
