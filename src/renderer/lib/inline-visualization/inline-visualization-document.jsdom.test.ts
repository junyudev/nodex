import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { buildInlineVisualizationDocument } from "./inline-visualization-document";

type GuestApi = {
  callTool: ReturnType<typeof vi.fn>;
  displayMode: "inline" | "fullscreen";
  visualizationTheme: "light" | "dark";
  visualizationStyleVariables: Record<string, string>;
  statePersistence?: "host" | "none";
  stateModelContext?: "untrusted" | "none";
};
type GuestWindow = Window & typeof globalThis & { openai: GuestApi };
const documents: HTMLIFrameElement[] = [];
const errors: Error[] = [];

function mountDocument(
  fragment: string,
  options: {
    statePersistence?: "host" | "none";
    displayMode?: "inline" | "fullscreen";
    lucide?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const callTool = vi.fn<(name: string, value: unknown) => Promise<unknown>>(async () => undefined);
  const position = vi.fn(async () => ({ x: 10.2, y: 20.7 }));
  const positionCleanup = vi.fn();
  const resizeDisconnect = vi.fn();
  const autoUpdate = vi.fn((_trigger: Element, _floating: Element, update: () => void) => {
    update();
    return positionCleanup;
  });
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  documents.push(frame);
  const window = frame.contentWindow as GuestWindow;
  window.addEventListener("error", (event) => {
    errors.push(new Error(event.message));
    event.preventDefault();
  });
  Object.assign(window, {
    openai: {
      callTool,
      displayMode: options.displayMode ?? "inline",
      visualizationTheme: "light",
      visualizationStyleVariables: { "--background": "#112233", "--icon-size": "18px" },
    },
    lucide: options.lucide ? { createIcons: options.lucide } : undefined,
    FloatingUIDOM: {
      computePosition: position,
      autoUpdate,
      offset: (value: unknown) => value,
      flip: (value: unknown) => value,
      shift: (value: unknown) => value,
      size: (value: unknown) => value,
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {
        resizeDisconnect();
      }
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = Number(this.dataset.top ?? (this.tagName === "BODY" ? 100 : 0));
    const height = Number(this.dataset.height ?? 0);
    return new window.DOMRect(0, top, 400, height);
  };
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.scrollHeight ?? 0);
    },
  });
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 400, 31.25);
  window.document.open();
  window.document.write(buildInlineVisualizationDocument(fragment, options));
  window.document.close();
  const toolCalls = (suffix: string) =>
    callTool.mock.calls
      .filter(([name]) => name === `__codex_inline_visualization_${suffix}__`)
      .map(([, value]) => value);
  const key = (target: Element, value: string) => {
    const event = new window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: value,
    });
    target.dispatchEvent(event);
    return event;
  };
  const pointer = (target: Element, type: string, extra: Partial<PointerEventInit> = {}) => {
    const event = new window.MouseEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      ...extra,
    });
    Object.defineProperty(event, "pointerType", { value: extra.pointerType ?? "mouse" });
    Object.defineProperty(event, "pointerId", { value: extra.pointerId ?? 1 });
    target.dispatchEvent(event);
    return event;
  };
  return {
    window,
    document: window.document,
    callTool,
    toolCalls,
    key,
    pointer,
    position,
    autoUpdate,
    positionCleanup,
    resizeDisconnect,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  errors.length = 0;
});
afterEach(() => {
  for (const frame of documents.splice(0)) {
    const window = frame.contentWindow as GuestWindow;
    window.dispatchEvent(new window.Event("pagehide"));
    frame.remove();
  }
  vi.useRealTimers();
  expect(errors).toEqual([]);
});

const tabs = `<nav class="nav" role="tablist">
<button id="tab-a" role="tab" aria-controls="panel-a">First</button>
<button id="tab-disabled" disabled role="tab" aria-controls="panel-disabled">Disabled</button>
<button id="tab-b" role="tab" aria-controls="panel-b">Second</button></nav>
<section id="panel-a" role="tabpanel">A</section><section id="panel-disabled" role="tabpanel">Disabled panel</section><section id="panel-b" role="tabpanel">B</section>`;
const carousel = `<div class="viz-carousel" aria-label="Alternatives"><section data-variant="First">A</section><section data-variant="Second">B</section></div>`;

describe("interactive document defaults", () => {
  test("authored code sees consistent persistence metadata and the same API before rendering", () => {
    const { document, window, callTool } = mountDocument(
      `<p>Content</p><script>
      document.body.dataset.persistence = openai.statePersistence;
      document.body.dataset.context = openai.stateModelContext;
      openai.callTool('authored-call', {});
    </script>`,
      { statePersistence: "host" },
    );
    expect(document.body.dataset.persistence).toBe("host");
    expect(document.body.dataset.context).toBe("untrusted");
    expect(window.openai.callTool).toBe(callTool);
    expect(callTool).toHaveBeenCalledWith("authored-call", {});
    const none = mountDocument("<p>Content</p>");
    expect(none.window.openai).toMatchObject({
      statePersistence: "none",
      stateModelContext: "none",
    });
  });

  test("host colors stay defaults while geometry follows updates and stale host variables clear", () => {
    const guest = mountDocument("<style>:root{--background:#abcdef}</style><p>Content</p>");
    expect(
      guest.window
        .getComputedStyle(guest.document.documentElement)
        .getPropertyValue("--background"),
    ).toBe("#abcdef");
    expect(guest.document.documentElement.style.getPropertyValue("--icon-size")).toBe("18px");
    guest.window.dispatchEvent(
      new guest.window.CustomEvent("openai:set_globals", {
        detail: { globals: { widgetState: { privateContent: { count: 1 } } } },
      }),
    );
    expect(guest.document.documentElement.style.getPropertyValue("--icon-size")).toBe("18px");
    expect(guest.document.documentElement.dataset.theme).toBe("light");
    guest.window.dispatchEvent(
      new guest.window.CustomEvent("openai:set_globals", {
        detail: {
          globals: {
            visualizationTheme: "dark",
            visualizationStyleVariables: { "--foreground": "#998877" },
          },
        },
      }),
    );
    expect(guest.document.documentElement.dataset.theme).toBe("dark");
    expect(guest.document.documentElement.style.getPropertyValue("--icon-size")).toBe("");
    expect(
      guest.window
        .getComputedStyle(guest.document.documentElement)
        .getPropertyValue("--background"),
    ).toBe("#abcdef");
    expect(
      guest.window
        .getComputedStyle(guest.document.documentElement)
        .getPropertyValue("--foreground"),
    ).toBe("#998877");
  });

  test("tabs preserve selected panels, ignore disabled choices, and consume navigation before fullscreen preview", async () => {
    const guest = mountDocument(tabs, { displayMode: "fullscreen" });
    const first = guest.document.getElementById("tab-a")!;
    const second = guest.document.getElementById("tab-b")!;
    const disabled = guest.document.getElementById("tab-disabled")!;
    expect(guest.document.getElementById("panel-b")!.hidden).toBe(true);
    disabled.click();
    expect(first.getAttribute("aria-selected")).toBe("true");
    const arrow = guest.key(first, "ArrowRight");
    await vi.advanceTimersByTimeAsync(0);
    expect(arrow.defaultPrevented).toBe(true);
    expect(guest.document.activeElement).toBe(second);
    expect(guest.document.getElementById("panel-a")!.hidden).toBe(true);
    expect(guest.document.getElementById("panel-b")!.getAttribute("aria-labelledby")).toBe("tab-b");
    expect(guest.toolCalls("preview_key")).toEqual([]);
    guest.key(second, "Home");
    expect(guest.document.activeElement).toBe(first);
    guest.window.dispatchEvent(new guest.window.Event("pagehide"));
    second.click();
    expect(first.getAttribute("aria-selected")).toBe("true");
  });

  test("carousel wraps variants, supports picker keyboard selection, and releases global dismissal listeners", () => {
    const guest = mountDocument(carousel);
    const root = guest.document.querySelector<HTMLElement>(".viz-carousel")!;
    guest.document.querySelector<HTMLButtonElement>('[aria-label="Previous variant"]')!.click();
    expect(root.dataset.activeVariant).toBe("Second");
    expect(root.querySelector<HTMLElement>('[data-variant="First"]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-variant="Second"]')!.hidden).toBe(false);
    expect(root.querySelector('[role="status"]')!.textContent).toBe("2 / 2: Second");
    const picker = root.querySelector<HTMLDetailsElement>("details")!;
    const summary = picker.querySelector("summary")!;
    guest.key(summary, "ArrowDown");
    expect(picker.open).toBe(true);
    const choices = picker.querySelectorAll<HTMLButtonElement>(".viz-carousel-options button");
    expect(guest.document.activeElement).toBe(choices[1]);
    guest.key(choices[1]!, "Home");
    expect(guest.document.activeElement).toBe(choices[0]);
    choices[0]!.click();
    expect(root.dataset.activeVariant).toBe("First");
    expect(picker.open).toBe(false);
    picker.open = true;
    guest.pointer(guest.document.body, "pointerdown");
    expect(picker.open).toBe(false);
    guest.window.dispatchEvent(new guest.window.Event("pagehide"));
    picker.open = true;
    guest.pointer(guest.document.body, "pointerdown");
    expect(picker.open).toBe(true);
  });

  test("Lucide initializes authored and generated controls immediately or on load, never after pagehide", () => {
    const createIcons = vi.fn();
    mountDocument(carousel + '<i data-lucide="plus"></i>', { lucide: createIcons });
    expect(createIcons).toHaveBeenCalledOnce();
    expect(createIcons).toHaveBeenCalledWith({ attrs: { width: 16, height: 16 } });
    const delayed = mountDocument('<i data-lucide="plus"></i>');
    Object.assign(delayed.window, { lucide: { createIcons } });
    delayed.document
      .getElementById("nodex-visualization-lucide")!
      .dispatchEvent(new delayed.window.Event("load"));
    expect(createIcons).toHaveBeenCalledTimes(2);
    const disposed = mountDocument('<i data-lucide="plus"></i>');
    Object.assign(disposed.window, { lucide: { createIcons } });
    disposed.window.dispatchEvent(new disposed.window.Event("pagehide"));
    disposed.document
      .getElementById("nodex-visualization-lucide")!
      .dispatchEvent(new disposed.window.Event("load"));
    expect(createIcons).toHaveBeenCalledTimes(2);
  });
});

describe("guest tooltip lifetime", () => {
  test("late positioning cannot mutate a replacement tooltip and failed positioning releases its owner", async () => {
    const guest = mountDocument(
      '<button id="first" data-tooltip="First tip">First</button><button id="second" data-tooltip="Second tip">Second</button>',
    );
    let resolveFirst!: (value: { x: number; y: number }) => void;
    let resolveSecond!: (value: { x: number; y: number }) => void;
    const firstResult = new Promise<{ x: number; y: number }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResult = new Promise<{ x: number; y: number }>((resolve) => {
      resolveSecond = resolve;
    });
    guest.position
      .mockImplementationOnce(() => firstResult)
      .mockImplementationOnce(() => secondResult);
    const first = guest.document.getElementById("first")!;
    const second = guest.document.getElementById("second")!;
    guest.pointer(first, "pointerover");
    await vi.advanceTimersByTimeAsync(700);
    guest.pointer(second, "pointerover");
    resolveFirst({ x: 100, y: 100 });
    await Promise.resolve();
    expect(guest.document.querySelector<HTMLElement>('[role="tooltip"]')!.style.visibility).toBe(
      "hidden",
    );
    resolveSecond({ x: 200, y: 200 });
    await Promise.resolve();
    expect(guest.document.querySelector<HTMLElement>('[role="tooltip"]')!.style.visibility).toBe(
      "visible",
    );
    expect(guest.document.querySelector('[role="tooltip"]')!.textContent).toBe("Second tip");
    guest.position.mockRejectedValueOnce(new Error("Position unavailable"));
    guest.pointer(first, "pointerover");
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.document.querySelector('[role="tooltip"]')).toBeNull();
    expect(guest.positionCleanup).toHaveBeenCalledTimes(3);
    expect(first.hasAttribute("aria-describedby")).toBe(false);
  });

  test("hover waits 700ms, preserves descriptions, skips repeat delay and releases position ownership", async () => {
    const guest = mountDocument(
      '<button id="first" data-tooltip="First tip" aria-describedby="original">First</button><button id="second" data-tooltip="Second tip">Second</button>',
    );
    const first = guest.document.getElementById("first")!;
    const second = guest.document.getElementById("second")!;
    guest.pointer(first, "pointerover");
    await vi.advanceTimersByTimeAsync(699);
    expect(guest.document.querySelector('[role="tooltip"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(guest.document.querySelector('[role="tooltip"]')!.textContent).toBe("First tip");
    expect(first.getAttribute("aria-describedby")!.split(" ")).toContain("original");
    expect(guest.autoUpdate).toHaveBeenCalledOnce();
    guest.pointer(first, "pointerout");
    expect(first.getAttribute("aria-describedby")).toBe("original");
    expect(guest.positionCleanup).toHaveBeenCalledOnce();
    guest.pointer(second, "pointerover");
    await Promise.resolve();
    expect(guest.document.querySelector('[role="tooltip"]')!.textContent).toBe("Second tip");
    guest.window.dispatchEvent(new guest.window.Event("pagehide"));
    expect(guest.positionCleanup).toHaveBeenCalledTimes(2);
    expect(guest.document.querySelector('[role="tooltip"]')).toBeNull();
    guest.pointer(first, "pointerover");
    await vi.advanceTimersByTimeAsync(1000);
    expect(guest.document.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("touch pins the tooltip until a second tap and discovers shadow-root triggers", async () => {
    const guest = mountDocument(`<section id="shadow-host"></section><script>
      document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML = '<button data-tooltip="Shadow tip">Touch</button>';
    </script>`);
    const button = guest.document
      .getElementById("shadow-host")!
      .shadowRoot!.querySelector("button")!;
    guest.pointer(button, "pointerdown", { pointerType: "touch" });
    guest.pointer(button, "click", { pointerType: "touch", detail: 1 });
    await Promise.resolve();
    expect(guest.document.querySelector('[role="tooltip"]')!.textContent).toBe("Shadow tip");
    guest.pointer(button, "pointerout", { pointerType: "touch" });
    expect(guest.document.querySelector('[role="tooltip"]')).not.toBeNull();
    guest.pointer(button, "click", { pointerType: "touch", detail: 1 });
    expect(guest.document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("conditional calendar", () => {
  test("calendar and carousel controls render local icons without a guest React or Lucide runtime", () => {
    const guest = mountDocument(
      `${carousel}<viz-calendar date="2026-10-12" events='[{"title":"Call","start":"09:00","end":"10:00","video":true}]'></viz-calendar>`,
    );
    const caret = guest.document.querySelector("summary svg")!;
    const video = guest.document
      .querySelector("viz-calendar")!
      .shadowRoot!.querySelector("button svg")!;
    for (const icon of [caret, video]) {
      expect(icon).toBeInstanceOf(guest.window.SVGElement);
      expect(icon.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("registration happens only for calendar fragments and first parse builds valid escaped events", () => {
    const empty = mountDocument("<p>Ordinary content</p>");
    expect(empty.window.customElements.get("viz-calendar")).toBeUndefined();
    const guest = mountDocument(
      `<viz-calendar id="calendar" date="2026-10-12" interactive events='[{"title":"Hidden","start":"07:00","end":"08:00"},{"title":"&lt;img&gt;","start":"09:00","end":"10:00"},{"title":"Overlap","start":"09:30","end":"10:30"},{"title":"Adjacent","start":"10:30","end":"11:00"}]'></viz-calendar>`,
    );
    const calendar = guest.document.getElementById("calendar")!;
    const shadow = calendar.shadowRoot!;
    expect(shadow.querySelector('[role="alert"]')).toBeNull();
    expect(shadow.querySelectorAll(".event")).toHaveLength(3);
    expect(shadow.querySelector("img")).toBeNull();
    const buttons = shadow.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons[0]!.getAttribute("aria-label")).toBe("<img>, 09:00-10:00");
    const events = shadow.querySelectorAll<HTMLElement>(".event");
    expect(events[0]!.style.getPropertyValue("--lanes")).toBe("2");
    expect(events[1]!.style.getPropertyValue("--lane")).toBe("1");
    expect(events[2]!.style.getPropertyValue("--lanes")).toBe("1");
    const selected = vi.fn();
    calendar.addEventListener("eventselect", selected);
    buttons[0]!.click();
    expect(selected).toHaveBeenCalledOnce();
    expect((selected.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      index: 1,
      event: { title: "<img>" },
    });
  });

  test("invalid calendar data stays visible and updating attributes recovers the same element", () => {
    const guest = mountDocument('<viz-calendar id="calendar" date="2026-02-30"></viz-calendar>');
    const calendar = guest.document.getElementById("calendar")!;
    expect(calendar.shadowRoot!.querySelector('[role="alert"]')!.textContent).toBe(
      "Supply a valid calendar date as YYYY-MM-DD.",
    );
    calendar.setAttribute("date", "2026-10-12");
    expect(calendar.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
    calendar.setAttribute("events", '[{"title":"Broken","start":"09:00","end":"08:00"}]');
    expect(calendar.shadowRoot!.querySelector('[role="alert"]')!.textContent).toBe(
      "An event must end after it starts.",
    );
    calendar.setAttribute("events", "[]");
    expect(calendar.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("document height and fullscreen keyboard", () => {
  test("pure text uses a Range while multiple roots measure the greatest bottom and exclude tooltips", () => {
    const text = mountDocument("Plain text without a root element");
    expect(text.toolCalls("height")).toEqual([{ height: 31.25, width: 1024 }]);
    const roots = mountDocument(
      '<section data-top="110" data-height="40">First</section><section data-top="160" data-height="45.5">Second</section><div role="tooltip" data-top="1000" data-height="600">Floating hint</div>',
    );
    expect(roots.toolCalls("height")).toEqual([{ height: 105.5, width: 1024 }]);
  });

  test("height uses actual collapsed top gap, keeps fractional geometry and suppresses viewport feedback only", async () => {
    const guest = mountDocument(
      '<style>body{padding:8px 16px}</style><section id="content" data-top="130" data-height="100.5" data-scroll-height="120">Content</section>',
    );
    expect(guest.toolCalls("height")).toEqual([{ height: 142, width: 992 }]);
    const content = guest.document.getElementById("content")!;
    Object.defineProperty(guest.window, "innerHeight", { value: 808, configurable: true });
    content.dataset.scrollHeight = "160";
    guest.window.dispatchEvent(new guest.window.Event("resize"));
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.toolCalls("height")).toHaveLength(1);
    content.dataset.scrollHeight = "160.25";
    guest.window.dispatchEvent(new guest.window.Event("resize"));
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.toolCalls("height").at(-1)).toEqual({ height: 182.25, width: 992 });
    guest.window.dispatchEvent(new guest.window.Event("pagehide"));
    const count = guest.toolCalls("height").length;
    content.dataset.scrollHeight = "220";
    guest.window.dispatchEvent(new guest.window.Event("resize"));
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.toolCalls("height")).toHaveLength(count);
    expect(guest.resizeDisconnect).toHaveBeenCalled();
  });

  test("preview receives only unconsumed fullscreen keys, allows Escape from editing and protects composite controls", async () => {
    const guest = mountDocument(
      '<section id="plain">Content</section><input id="input"><div contenteditable="" id="editable"><span id="child">Edit</span></div><div role="grid" id="grid">Grid</div>',
    );
    const plain = guest.document.getElementById("plain")!;
    guest.key(plain, "ArrowLeft");
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.toolCalls("preview_key")).toEqual([]);
    guest.window.openai.displayMode = "fullscreen";
    guest.key(guest.document.getElementById("input")!, "ArrowLeft");
    guest.key(guest.document.getElementById("child")!, "ArrowRight");
    guest.key(guest.document.getElementById("grid")!, "ArrowRight");
    guest.key(guest.document.getElementById("input")!, "Escape");
    guest.key(plain, "ArrowRight");
    plain.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    guest.key(plain, "ArrowLeft");
    await vi.advanceTimersByTimeAsync(0);
    expect(guest.toolCalls("preview_key")).toEqual([{ key: "Escape" }, { key: "ArrowRight" }]);
  });
});
