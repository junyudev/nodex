import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion";
import { afterEach } from "vite-plus/test";
import { installMotionPreferenceForTest } from "./browser-globals";

const nativeRequest = Request;
const nativeResponse = Response;
const nativeHeaders = Headers;
const nativeFetch = fetch;
const nativeURL = URL;
const nativeCSS = globalThis.CSS ?? {
  escape(value: string) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  },
};

// Renderer behavior tests assert settled product state without impersonating a
// user's accessibility preference. Motion contracts opt into live timelines;
// reduced-motion contracts set that preference explicitly.
installMotionPreferenceForTest(false, { skipAnimations: true });
if (typeof globalThis.PointerEvent !== "function") {
  Object.defineProperty(globalThis, "PointerEvent", {
    configurable: true,
    writable: true,
    value: class PointerEvent extends MouseEvent {},
  });
}
if (typeof globalThis.SVGPathElement !== "function") {
  Object.defineProperty(globalThis, "SVGPathElement", {
    configurable: true,
    writable: true,
    value: globalThis.SVGElement,
  });
}
if (typeof globalThis.ResizeObserver !== "function") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}
if (typeof globalThis.IntersectionObserver !== "function") {
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: class IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  });
}
Object.defineProperty(window, "scrollTo", {
  configurable: true,
  writable: true,
  value: () => undefined,
});
Object.defineProperty(window, "scrollBy", {
  configurable: true,
  writable: true,
  value: () => undefined,
});
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  writable: true,
  value: () => undefined,
});
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  writable: true,
  value(optionsOrX?: ScrollToOptions | number, y?: number) {
    if (typeof optionsOrX === "number") {
      this.scrollLeft = optionsOrX;
      this.scrollTop = y ?? 0;
      return;
    }
    if (typeof optionsOrX?.left === "number") this.scrollLeft = optionsOrX.left;
    if (typeof optionsOrX?.top === "number") this.scrollTop = optionsOrX.top;
  },
});
Object.defineProperty(HTMLElement.prototype, "scrollBy", {
  configurable: true,
  writable: true,
  value(optionsOrX?: ScrollToOptions | number, y?: number) {
    if (typeof optionsOrX === "number") {
      this.scrollLeft += optionsOrX;
      this.scrollTop += y ?? 0;
      return;
    }
    if (typeof optionsOrX?.left === "number") this.scrollLeft += optionsOrX.left;
    if (typeof optionsOrX?.top === "number") this.scrollTop += optionsOrX.top;
  },
});
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  writable: true,
  value: () => null,
});
const emptyDomRect = (): DOMRect => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
});
Object.defineProperty(Range.prototype, "getBoundingClientRect", {
  configurable: true,
  writable: true,
  value: emptyDomRect,
});
Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  writable: true,
  value: () => {
    const rects = [emptyDomRect()] as DOMRect[] & { item(index: number): DOMRect | null };
    rects.item = (index) => rects[index] ?? null;
    return rects;
  },
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const browserWindow = window;
const browserDocument = document;
const browserCustomEvent = browserWindow.CustomEvent;
const browserMatchMedia = browserWindow.matchMedia;
const browserSkipAnimations = MotionGlobalConfig.skipAnimations;
const browserWindowApiDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "api");
function createDefaultRendererApi(): NonNullable<Window["api"]> {
  let persistedAtomRevision = 0;
  const persistedAtomValues: Record<string, unknown> = {};
  const persistedAtomListeners = new Set<(...args: unknown[]) => void>();

  return {
    invoke: async (channel, ...args) => {
      if (channel === "persisted-atom:sync-request") {
        return {
          revision: persistedAtomRevision,
          values: { ...persistedAtomValues },
        };
      }
      if (channel === "codex:app-server:request") {
        return { type: "result", result: undefined };
      }
      if (channel !== "persisted-atom:update") return undefined;

      const mutation = args[0] as {
        key: string;
        mutationId: string;
        value: unknown;
      };
      persistedAtomRevision += 1;
      persistedAtomValues[mutation.key] = mutation.value;
      const event = {
        ...mutation,
        revision: persistedAtomRevision,
        originRendererId: "renderer-test",
      };
      for (const listener of persistedAtomListeners) listener(event);
      return event;
    },
    on: (event, callback) => {
      if (event !== "persisted-atom:updated") return () => undefined;
      persistedAtomListeners.add(callback);
      return () => {
        persistedAtomListeners.delete(callback);
      };
    },
  };
}
const browserLocalStorage = localStorage;
const browserSessionStorage = sessionStorage;
const browserNode = globalThis.Node;
const browserElement = globalThis.Element;
const browserHTMLElement = globalThis.HTMLElement;
const browserHTMLDivElement = globalThis.HTMLDivElement;
const browserEvent = globalThis.Event;
const browserKeyboardEvent = globalThis.KeyboardEvent;
const browserMouseEvent = globalThis.MouseEvent;
const browserPointerEvent = globalThis.PointerEvent;
const browserRequestAnimationFrame = globalThis.requestAnimationFrame;
const browserCancelAnimationFrame = globalThis.cancelAnimationFrame;
const browserResizeObserver = globalThis.ResizeObserver;
const browserGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const browserScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);

function ensureHtmlDoctype() {
  if (document.doctype?.name.toLowerCase() === "html") return;
  const documentType = document.implementation.createDocumentType("html", "", "");
  document.insertBefore(documentType, document.documentElement);
}

function ensureStandardsMode() {
  if (document.compatMode === "CSS1Compat") return;
  Object.defineProperty(document, "compatMode", {
    configurable: true,
    value: "CSS1Compat",
  });
}

function restoreBrowserGlobals() {
  Object.defineProperty(globalThis, "Request", {
    configurable: true,
    writable: true,
    value: nativeRequest,
  });
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: nativeResponse,
  });
  Object.defineProperty(globalThis, "Headers", {
    configurable: true,
    writable: true,
    value: nativeHeaders,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: nativeFetch,
  });
  Object.defineProperty(globalThis, "URL", {
    configurable: true,
    writable: true,
    value: nativeURL,
  });
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    writable: true,
    value: nativeCSS,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: browserWindow,
  });
  if (browserWindowApiDescriptor) {
    Object.defineProperty(browserWindow, "api", browserWindowApiDescriptor);
  } else {
    Object.defineProperty(browserWindow, "api", {
      configurable: true,
      writable: true,
      value: createDefaultRendererApi(),
    });
  }
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: browserDocument,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: browserLocalStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: browserSessionStorage,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    writable: true,
    value: browserNode,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    writable: true,
    value: browserElement,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    writable: true,
    value: browserHTMLElement,
  });
  Object.defineProperty(globalThis, "HTMLDivElement", {
    configurable: true,
    writable: true,
    value: browserHTMLDivElement,
  });
  Object.defineProperty(globalThis, "Event", {
    configurable: true,
    writable: true,
    value: browserEvent,
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    writable: true,
    value: browserCustomEvent,
  });
  Object.defineProperty(browserWindow, "matchMedia", {
    configurable: true,
    writable: true,
    value: browserMatchMedia,
  });
  MotionGlobalConfig.skipAnimations = browserSkipAnimations;
  Object.defineProperty(globalThis, "KeyboardEvent", {
    configurable: true,
    writable: true,
    value: browserKeyboardEvent,
  });
  Object.defineProperty(globalThis, "MouseEvent", {
    configurable: true,
    writable: true,
    value: browserMouseEvent,
  });
  if (typeof browserPointerEvent === "undefined") {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { PointerEvent?: typeof PointerEvent },
      "PointerEvent",
    );
  } else {
    Object.defineProperty(globalThis, "PointerEvent", {
      configurable: true,
      writable: true,
      value: browserPointerEvent,
    });
  }
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: browserRequestAnimationFrame,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: browserCancelAnimationFrame,
  });
  if (typeof browserResizeObserver === "undefined") {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { ResizeObserver?: typeof ResizeObserver },
      "ResizeObserver",
    );
  } else {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: browserResizeObserver,
    });
  }
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: browserGetBoundingClientRect,
  });
  if (browserScrollHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", browserScrollHeightDescriptor);
  } else {
    Reflect.deleteProperty(
      HTMLElement.prototype as HTMLElement & { scrollHeight?: number },
      "scrollHeight",
    );
  }
}

restoreBrowserGlobals();
ensureHtmlDoctype();
ensureStandardsMode();

afterEach(() => {
  try {
    cleanup();
  } finally {
    restoreBrowserGlobals();
    ensureHtmlDoctype();
    ensureStandardsMode();
    localStorage.clear();
    sessionStorage.clear();
    document.body.innerHTML = "";
    document.body.removeAttribute("style");
  }
});
