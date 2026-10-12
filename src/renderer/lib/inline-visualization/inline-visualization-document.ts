import { buildInlineVisualizationCalendar } from "./inline-visualization-calendar";
import { buildInlineVisualizationHelpers } from "./inline-visualization-document-helpers";
import { buildInlineVisualizationDownloadScript } from "./inline-visualization-download";
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

export interface InlineVisualizationDocumentOptions {
  readonly statePersistence?: "host" | "none";
  readonly downloadCapability?: string;
  readonly lockDocumentOverflow?: boolean;
}

/** The document receives API metadata, never a second copy of persisted widget state. */
function installDocumentBridge(statePersistence: "host" | "none") {
  const widgetWindow = window as Window & {
    openai?: {
      callTool?(name: string, args: unknown): Promise<unknown>;
      statePersistence?: "host" | "none";
      stateModelContext?: "untrusted" | "none";
      visualizationTheme?: string;
      visualizationStyleVariables?: Record<string, string>;
    };
  };
  widgetWindow.openai ??= {};
  widgetWindow.openai.statePersistence = statePersistence;
  widgetWindow.openai.stateModelContext = statePersistence === "host" ? "untrusted" : "none";
  const hostStyles = document.getElementById("nodex-visualization-host-theme") as HTMLStyleElement;
  const hostStyle = (hostStyles.sheet?.cssRules[0] as CSSStyleRule | undefined)?.style;
  const styleForProperty = (property: string) =>
    /^--(?:font-|radius|corner-shape$|control-spacing$|cursor-interaction$|icon-size$|visualize-paint-gutter$)/.test(
      property,
    )
      ? document.documentElement.style
      : hostStyle;
  let appliedProperties: string[] = [];
  const notify = (suffix: string, value: unknown) => {
    void widgetWindow.openai
      ?.callTool?.(`__codex_inline_visualization_${suffix}__`, value)
      .catch(() => undefined);
  };
  const syncTheme = (event?: Event) => {
    const api =
      event instanceof CustomEvent
        ? (event.detail as { globals?: typeof widgetWindow.openai } | undefined)?.globals
        : widgetWindow.openai;
    const variables = api?.visualizationStyleVariables;
    if (variables != null && typeof variables === "object") {
      for (const name of appliedProperties) styleForProperty(name)?.removeProperty(name);
      appliedProperties = [];
      for (const [name, value] of Object.entries(variables)) {
        if (!name.startsWith("--") || typeof value !== "string") continue;
        styleForProperty(name)?.setProperty(name, value);
        appliedProperties.push(name);
      }
    }
    const theme = api?.visualizationTheme;
    if (typeof theme !== "string") return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const sandboxDocument = window.frameElement?.ownerDocument;
    if (!sandboxDocument) return;
    let meta = sandboxDocument.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (!meta) {
      meta = sandboxDocument.createElement("meta");
      meta.name = "color-scheme";
      sandboxDocument.head.appendChild(meta);
    }
    meta.content = theme;
    sandboxDocument.documentElement.style.colorScheme = theme;
    sandboxDocument.documentElement.style.backgroundColor =
      hostStyle?.getPropertyValue("--background") ?? "";
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
  window.addEventListener(
    "pagehide",
    () => window.removeEventListener("openai:set_globals", syncTheme),
    { once: true },
  );
}

/** Installs after the authored fragment, before optional network-loaded UI helpers. */
function installDocumentRuntime() {
  const widgetWindow = window as Window & {
    openai?: {
      callTool?(name: string, args: unknown): Promise<unknown>;
      displayMode?: string;
    };
  };
  const notify = (suffix: string, value: unknown) => {
    void widgetWindow.openai
      ?.callTool?.(`__codex_inline_visualization_${suffix}__`, value)
      .catch(() => undefined);
  };
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  let previous: { height: number; width: number; viewportHeight: number } | null = null;
  const measure = () => {
    scheduled = null;
    const body = document.body;
    if (!body) return;
    const bounds = body.getBoundingClientRect();
    const style = getComputedStyle(body);
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
        Math.max(
          0,
          element.getBoundingClientRect().top -
            bounds.top -
            (Number.parseFloat(style.paddingTop) || 0),
        );
    } else if (children.length > 1) {
      height =
        Math.max(...children.map((element) => element.getBoundingClientRect().bottom)) - bounds.top;
    } else {
      const range = document.createRange();
      range.selectNodeContents(body);
      height = range.getBoundingClientRect().height;
    }
    const width = Math.max(
      0,
      Math.round(
        window.innerWidth -
          (Number.parseFloat(style.paddingLeft) || 0) -
          (Number.parseFloat(style.paddingRight) || 0),
      ),
    );
    height = Math.max(0, height);
    const viewportHeight = window.innerHeight;
    const feedback =
      previous?.width === width &&
      height - previous.height === viewportHeight - previous.viewportHeight;
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
        .filter((target): target is Element => target instanceof Element);
      const isInteractiveTarget =
        elements.some(
          (element) =>
            element.matches(interactiveSelector) ||
            (element.hasAttribute("tabindex") &&
              ((element as Element & { tabIndex?: number }).tabIndex ?? -1) >= 0),
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
  window.addEventListener("keydown", (event) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const target = event
      .composedPath()
      .find((element): element is HTMLElement => element instanceof HTMLElement);
    if (!["ArrowLeft", "ArrowRight", "Escape"].includes(event.key)) return;
    const editable = target?.closest("[contenteditable]");
    const editing =
      target?.isContentEditable ||
      (editable && editable.getAttribute("contenteditable") !== "false") ||
      target?.closest(
        'input,textarea,select,[role="slider"],[role="spinbutton"],[role="combobox"],[role="listbox"],[role="grid"],[role="tree"],[role="tablist"],[role="menu"]',
      );
    if (event.key !== "Escape" && editing) return;
    // Give authored controls the same opportunity to consume a key before forwarding it.
    setTimeout(() => {
      if (!event.defaultPrevented && widgetWindow.openai?.displayMode === "fullscreen")
        notify("preview_key", { key: event.key });
    }, 0);
  });
  let isHovering = false;
  let isTouch = false;
  const reportHover = (hovering: boolean, touch = false) => {
    if (hovering === isHovering && touch === isTouch) return;
    isHovering = hovering;
    isTouch = touch;
    notify("hover", touch ? { isHovering, pointerType: "touch" } : { isHovering });
  };
  window.addEventListener(
    "pointerover",
    (event) => reportHover(event.pointerType !== "touch", event.pointerType === "touch"),
    { capture: true },
  );
  window.addEventListener(
    "pointerout",
    (event) => {
      if (event.pointerType !== "touch" && event.relatedTarget === null) reportHover(false);
    },
    { capture: true },
  );
  const ready = () => {
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
        window.removeEventListener("resize", schedule);
        if (scheduled !== null) clearTimeout(scheduled);
      },
      { once: true },
    );
    notify("ready", {});
    measure();
  };
  ready();
}

export function buildInlineVisualizationDocument(
  fragment: string,
  options: InlineVisualizationDocumentOptions = {},
): string {
  return `<style>${documentStyles}</style><style id="nodex-visualization-host-theme">:root {}</style>
<script>(${installDocumentBridge.toString()})(${JSON.stringify(options.statePersistence ?? "none")});</script>
${buildInlineVisualizationCalendar(fragment)}${fragment}
<script>(${installDocumentRuntime.toString()})();</script>
${buildInlineVisualizationHelpers()}
${buildInlineVisualizationDownloadScript(options.downloadCapability)}
<style>html,body{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}</style>
${options.lockDocumentOverflow ? "<style>html,body{overflow-y:hidden!important}</style>" : ""}`;
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
