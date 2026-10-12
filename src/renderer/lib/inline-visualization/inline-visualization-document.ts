import documentStyles from "./inline-visualization-document.css?inline";

export const INLINE_VISUALIZATION_MAX_HEIGHT = 10_000;
export const INLINE_VISUALIZATION_INITIAL_HEIGHT = 240;

export const INLINE_VISUALIZATION_CSP = {
  baseUriDomains: [],
  connectDomains: ["blob:", "data:"],
  frameDomains: [],
  includeDefaultDomains: false,
  isTrusted: true,
  resourceDomains: [
    "blob:",
    "data:",
    "https://persistent.oaistatic.com/plugins/visualize/charts/",
    "https://cdnjs.cloudflare.com",
    "https://cdn.jsdelivr.net",
    "https://esm.sh",
    "https://fonts.bunny.net",
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
    "https://unpkg.com",
  ],
};

/** Runs inside the untrusted document, with only the Skybridge widget API. */
function installDocumentRuntime() {
  const widgetWindow = window as Window & {
    openai?: {
      callTool(name: string, args: unknown): Promise<unknown>;
      visualizationTheme?: string;
      visualizationStyleVariables?: Record<string, string>;
    };
  };
  const notify = (suffix: string, value: unknown) => {
    void widgetWindow.openai
      ?.callTool(`__codex_inline_visualization_${suffix}__`, value)
      .catch(() => undefined);
  };
  const syncTheme = () => {
    const api = widgetWindow.openai;
    const theme = api?.visualizationTheme ?? "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    for (const [name, value] of Object.entries(api?.visualizationStyleVariables ?? {})) {
      if (name.startsWith("--")) document.documentElement.style.setProperty(name, value);
    }
  };
  syncTheme();
  window.addEventListener("openai:set_globals", syncTheme);
  window.addEventListener("error", (event) => {
    notify("error", { message: event.message, name: event.error?.name, stack: event.error?.stack });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const error = event.reason;
    notify("error", {
      message: String(error?.message ?? error),
      name: error?.name,
      stack: error?.stack,
    });
  });
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let previous: { height: number; width: number; viewportHeight: number } | null = null;
  const measure = () => {
    scheduled = null;
    const body = document.body;
    if (!body) return;
    const bounds = body.getBoundingClientRect();
    const children = Array.from(body.children).filter(
      (element) =>
        !["SCRIPT", "STYLE"].includes(element.tagName) &&
        element.getAttribute("role") !== "tooltip",
    );
    let height = 0;
    if (children.length === 1) {
      const element = children[0]! as HTMLElement;
      height =
        Math.max(element.scrollHeight, element.getBoundingClientRect().height) +
        Math.max(0, Number.parseFloat(getComputedStyle(element).marginTop) || 0);
    } else if (children.length > 1) {
      height =
        Math.max(...children.map((element) => element.getBoundingClientRect().bottom)) - bounds.top;
    } else {
      const range = document.createRange();
      range.selectNodeContents(body);
      height = range.getBoundingClientRect().height;
    }
    const style = getComputedStyle(body);
    const width = Math.max(
      0,
      Math.round(
        window.innerWidth -
          (Number.parseFloat(style.paddingLeft) || 0) -
          (Number.parseFloat(style.paddingRight) || 0),
      ),
    );
    height = Math.max(0, Math.ceil(height));
    const viewportHeight = window.innerHeight;
    const feedback =
      previous?.width === width &&
      height - previous.height === viewportHeight - previous.viewportHeight;
    if (previous?.height === height && previous.width === width) return;
    previous = { height, width, viewportHeight };
    if (!feedback) notify("height", { height, width });
  };
  // Offscreen guest frames suspend rAF, so document measurement uses a task.
  const schedule = () => {
    if (scheduled === null) scheduled = setTimeout(measure, 0);
  };
  const bubbledClicks = new WeakSet<Event>();
  const interactiveSelector = [
    "button",
    "input",
    "select",
    "textarea",
    "label",
    "summary",
    "a[href]",
    "audio[controls]",
    "video[controls]",
    "[onclick]",
    "[data-visualization-interactive]",
    '[contenteditable]:not([contenteditable="false"])',
    ...[
      "button",
      "checkbox",
      "combobox",
      "gridcell",
      "link",
      "listbox",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "radio",
      "scrollbar",
      "searchbox",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
      "treeitem",
    ].map((role) => `[role~="${role}"]`),
  ].join(",");
  window.addEventListener("click", (event) => bubbledClicks.add(event));
  window.addEventListener(
    "click",
    (event) => {
      const elements = event
        .composedPath()
        .filter((target): target is HTMLElement => target instanceof HTMLElement);
      const isInteractiveTarget =
        elements.some(
          (element) =>
            element.matches(interactiveSelector) ||
            (element.hasAttribute("tabindex") && element.tabIndex >= 0),
        ) || Boolean(elements[0] && getComputedStyle(elements[0]).cursor === "pointer");
      setTimeout(
        () =>
          notify("click", {
            isInteractive:
              isInteractiveTarget ||
              event.defaultPrevented ||
              (event.bubbles && !bubbledClicks.has(event)),
          }),
        0,
      );
    },
    { capture: true },
  );
  document.addEventListener("keydown", (event) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const target = event
      .composedPath()
      .find((element): element is HTMLElement => element instanceof HTMLElement);
    if (
      target?.isContentEditable ||
      target?.closest('input,textarea,select,[role="slider"],[role="spinbutton"],[role="combobox"]')
    )
      return;
    if (!["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    notify("preview_key", { key: event.key });
  });
  document.addEventListener("pointerenter", () => notify("hover", { isHovering: true }));
  document.addEventListener("pointerleave", () => notify("hover", { isHovering: false }));
  const ready = () => {
    syncTheme();
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    const resize = new ResizeObserver(schedule);
    const observeChildren = () => {
      resize.disconnect();
      resize.observe(document.body);
      for (const child of document.body.children) resize.observe(child);
    };
    observeChildren();
    const mutations = new MutationObserver(() => {
      observeChildren();
      schedule();
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "height", "width"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener(
      "pagehide",
      () => {
        mutations.disconnect();
        resize.disconnect();
        if (scheduled !== null) clearTimeout(scheduled);
      },
      { once: true },
    );
    notify("ready", {});
    schedule();
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
}

export function buildInlineVisualizationDocument(fragment: string): string {
  return `<style>${documentStyles}</style><script>(${installDocumentRuntime.toString()})();</script>${fragment}`;
}

export function parseInlineVisualizationHeight(value: unknown): number | null {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const height = record?.height ?? value;
  if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return null;
  if (
    record?.width !== undefined &&
    (typeof record.width !== "number" || !Number.isFinite(record.width) || record.width < 0)
  )
    return null;
  return Math.min(Math.ceil(height), INLINE_VISUALIZATION_MAX_HEIGHT);
}
