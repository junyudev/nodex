import type { Page } from "@playwright/test";

interface FindDiagnosticEntry {
  readonly sequence: number;
  readonly atMs: number;
  readonly event: string;
  readonly query: string | null;
  readonly details: object | null;
  readonly viewport: object | null;
  readonly marks: readonly object[];
  readonly rows: readonly object[];
}

export interface TranscriptFindDiagnostic {
  readonly boundary: string;
  readonly query: string | null;
  readonly totalEvents: number;
  readonly droppedEvents: number;
  readonly entries: readonly FindDiagnosticEntry[];
}

interface DiagnosticWindow extends Window {
  __nodexTranscriptFindDiagnostic?: {
    read(): TranscriptFindDiagnostic;
    dispose(): void;
  };
}

/** Opt-in correctness evidence only; the native scroll method and its arguments stay intact. */
export async function installTranscriptFindDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as DiagnosticWindow;
    scope.__nodexTranscriptFindDiagnostic?.dispose();
    const viewportSelector = "[data-local-conversation-thread-body=true]";
    const querySelector = 'input[placeholder="Search chat…"]';
    const rowSelector = "[data-turn-key], [data-content-search-turn-key]";
    const capacity = 192;
    const entries: FindDiagnosticEntry[] = [];
    const identities = new WeakMap<Element, number>();
    let nextIdentity = 0;
    let totalEvents = 0;
    let query: string | null = null;
    let frame: number | null = null;
    const frameReasons = new Set<string>();
    const viewport = () => document.querySelector<HTMLElement>(viewportSelector);
    const identity = (element: Element) => {
      const previous = identities.get(element);
      if (previous !== undefined) return previous;
      const value = ++nextIdentity;
      identities.set(element, value);
      return value;
    };
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        height: box.height,
        width: box.width,
      };
    };
    const address = (element: Element) => ({
      node: identity(element),
      tag: element.tagName,
      turnKey: element.getAttribute("data-turn-key"),
      searchTurnKey: element.getAttribute("data-content-search-turn-key"),
      unitKey: element.getAttribute("data-content-search-unit-key"),
      nativeItemId: element.getAttribute("data-native-promotion-item-id"),
      connected: element.isConnected,
    });
    const sample = (event: string, details: object | null = null) => {
      const body = viewport();
      const box = body ? rect(body) : null;
      const marks = body
        ? [...body.querySelectorAll("mark")].slice(0, 8).map((mark) => {
            const bounds = rect(mark);
            const row = mark.closest(rowSelector);
            return {
              ...address(mark),
              text: mark.textContent?.slice(0, 96) ?? null,
              active: mark.classList.contains("codex-thread-find-active"),
              rect: bounds,
              intersectsViewport:
                box !== null &&
                bounds.height > 0 &&
                bounds.bottom > box.top &&
                bounds.top < box.bottom,
              row: row ? address(row) : null,
            };
          })
        : [];
      const rows = body
        ? [...body.querySelectorAll(rowSelector)].slice(0, 48).map((row) => ({
            ...address(row),
            rect: rect(row),
          }))
        : [];
      totalEvents += 1;
      entries.push({
        sequence: totalEvents,
        atMs: performance.now(),
        event,
        query,
        details,
        viewport: body
          ? {
              ...address(body),
              rect: box,
              scrollTop: body.scrollTop,
              scrollHeight: body.scrollHeight,
              clientHeight: body.clientHeight,
              windowWidth: innerWidth,
              windowHeight: innerHeight,
              flexDirection: getComputedStyle(body).flexDirection,
              topOrigin: body.getAttribute("data-thread-scroll-top-origin"),
            }
          : null,
        marks,
        rows,
      });
      if (entries.length > capacity) entries.shift();
    };
    // A diagnostic failure must never replace the real native call's outcome.
    const record = (event: string, details: object | null = null) => {
      try {
        sample(event, details);
      } catch {
        /* Best-effort evidence only. */
      }
    };
    const afterFrame = (reason: string) => {
      frameReasons.add(reason);
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          const reasons = [...frameReasons];
          frameReasons.clear();
          record("two-rAF", { reasons });
        });
      });
    };
    const onInput = (event: Event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.matches(querySelector))
        return;
      query = event.target.value;
      record("query-input");
      afterFrame("query-input");
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.matches(viewportSelector)) return;
      record("scroll");
      afterFrame("scroll");
    };
    const observer = new MutationObserver((changes) => {
      const body = viewport();
      const relevant = changes.filter(
        (change) =>
          body?.contains(change.target) ||
          [...change.addedNodes, ...change.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(viewportSelector) || node.querySelector(viewportSelector) !== null),
          ),
      );
      if (relevant.length === 0) return;
      record("DOM-mutation", {
        count: relevant.length,
        changes: relevant.slice(0, 8).map((change) => ({
          type: change.type,
          target:
            change.target instanceof Element
              ? address(change.target)
              : change.target.parentElement
                ? address(change.target.parentElement)
                : null,
          attribute: change.attributeName,
          added: [...change.addedNodes]
            .slice(0, 4)
            .map((node) => (node instanceof Element ? address(node) : { type: node.nodeType })),
          removed: [...change.removedNodes]
            .slice(0, 4)
            .map((node) => (node instanceof Element ? address(node) : { type: node.nodeType })),
        })),
      });
      afterFrame("DOM-mutation");
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "data-turn-key",
        "data-content-search-turn-key",
        "data-content-search-unit-key",
      ],
    });
    const belongsToThread = (element: Element) =>
      Boolean(element.closest(viewportSelector)) ||
      element.matches("mark.codex-thread-find-active");
    const observeWrite = (
      element: Element,
      method: string,
      args: readonly unknown[],
      before: boolean,
    ) => {
      try {
        const options = args.map((argument) => {
          if (typeof argument !== "object" || argument === null) return argument ?? null;
          const properties = Object.getOwnPropertyDescriptors(argument);
          return Object.fromEntries(
            ["behavior", "block", "inline", "top", "left"].flatMap((key) => {
              const property = properties[key];
              return property && "value" in property ? [[key, property.value]] : [];
            }),
          );
        });
        const row = element.closest(rowSelector);
        record(`${method}-${before ? "before" : "after"}`, {
          target: { ...address(element), rect: rect(element), row: row ? address(row) : null },
          arguments: options,
          ...(before ? { callSite: new Error().stack?.split("\n").slice(2, 8) ?? [] } : {}),
        });
      } catch {
        /* Evidence must not replace a native call or setter outcome. */
      }
    };
    const intoViewDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const nativeIntoView = Element.prototype.scrollIntoView;
    const observedScrollIntoView: Element["scrollIntoView"] = function (this: Element, ...args) {
      const owned = this instanceof Element && belongsToThread(this);
      if (owned) observeWrite(this, "native-scrollIntoView", args, true);
      try {
        return Reflect.apply(nativeIntoView, this, args);
      } finally {
        if (owned) {
          observeWrite(this, "native-scrollIntoView", args, false);
          afterFrame("native-scrollIntoView");
        }
      }
    };
    const toDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
    const nativeTo = Element.prototype.scrollTo;
    const observedScrollTo: Element["scrollTo"] = function (
      this: Element,
      ...args: unknown[]
    ): void {
      const owned = this instanceof Element && belongsToThread(this);
      if (owned) observeWrite(this, "native-scrollTo", args, true);
      try {
        return Reflect.apply(nativeTo, this, args);
      } finally {
        if (owned) {
          observeWrite(this, "native-scrollTo", args, false);
          afterFrame("native-scrollTo");
        }
      }
    };
    const topDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const nativeTopSetter = topDescriptor?.set;
    const observedTopSetter = nativeTopSetter
      ? function (this: Element, value: number) {
          const owned = this instanceof Element && belongsToThread(this);
          if (owned) observeWrite(this, "native-scrollTop-set", [value], true);
          try {
            return Reflect.apply(nativeTopSetter, this, [value]);
          } finally {
            if (owned) {
              observeWrite(this, "native-scrollTop-set", [value], false);
              afterFrame("native-scrollTop-set");
            }
          }
        }
      : null;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      ...intoViewDescriptor,
      value: observedScrollIntoView,
    });
    Object.defineProperty(Element.prototype, "scrollTo", {
      ...toDescriptor,
      value: observedScrollTo,
    });
    if (observedTopSetter)
      Object.defineProperty(Element.prototype, "scrollTop", {
        ...topDescriptor,
        set: observedTopSetter,
      });
    document.addEventListener("input", onInput, true);
    document.addEventListener("scroll", onScroll, true);
    const read = (): TranscriptFindDiagnostic => ({
      boundary:
        "Opt-in correctness diagnostic. Bounded public DOM and original native scrollIntoView/scrollTo/scrollTop-set observations; timing samples from this run are not formal performance evidence.",
      query: document.querySelector<HTMLInputElement>(querySelector)?.value ?? query,
      totalEvents,
      droppedEvents: Math.max(0, totalEvents - entries.length),
      entries: [...entries],
    });
    scope.__nodexTranscriptFindDiagnostic = {
      read() {
        record("artifact-read");
        return read();
      },
      dispose() {
        observer.disconnect();
        document.removeEventListener("input", onInput, true);
        document.removeEventListener("scroll", onScroll, true);
        if (frame !== null) cancelAnimationFrame(frame);
        if (Element.prototype.scrollIntoView === observedScrollIntoView && intoViewDescriptor)
          Object.defineProperty(Element.prototype, "scrollIntoView", intoViewDescriptor);
        if (Element.prototype.scrollTo === observedScrollTo && toDescriptor)
          Object.defineProperty(Element.prototype, "scrollTo", toDescriptor);
        if (
          Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")?.set ===
            observedTopSetter &&
          topDescriptor
        )
          Object.defineProperty(Element.prototype, "scrollTop", topDescriptor);
        delete scope.__nodexTranscriptFindDiagnostic;
      },
    };
    record("installed");
  });
}

export async function readTranscriptFindDiagnostics(
  page: Page,
): Promise<TranscriptFindDiagnostic | null> {
  return await page.evaluate(
    () => (window as DiagnosticWindow).__nodexTranscriptFindDiagnostic?.read() ?? null,
  );
}

export async function disposeTranscriptFindDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as DiagnosticWindow).__nodexTranscriptFindDiagnostic?.dispose(),
  );
}
