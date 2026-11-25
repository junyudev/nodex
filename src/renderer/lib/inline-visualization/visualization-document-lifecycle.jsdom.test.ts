import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, test, describe, beforeEach, vi } from "vite-plus/test";
import { buildInlineVisualizationDocument } from "./inline-visualization-document";
import { createInlineVisualizationAnnotations } from "./inline-visualization-annotations";
import {
  VISUALIZATION_ANNOTATION_TOOL,
  type VisualizationAnnotationCommand,
} from "../../../shared/codex-visualization-annotations";
import {
  createInlineVisualizationFrameOwner,
  type InlineVisualizationFrameInput,
} from "./inline-visualization-frame-owner";
import type { InlineVisualizationRuntime } from "./inline-visualization-runtime";
import {
  createInlineVisualizationStandby,
  scheduleInlineVisualizationIdle,
} from "./inline-visualization-standby";
import { startInlineVisualizationPrewarmer } from "./inline-visualization-prewarmer";
import type { InlineVisualizationPreparedLease } from "./inline-visualization-prepared";
import {
  createInlineVisualizationStateUpdateHandler,
  resolveInlineVisualizationStateIdentity,
  type InlineVisualizationWidgetStateOwner,
} from "./inline-visualization-widget-state";

describe("inline visualization annotations document", () => {
  const frames: HTMLIFrameElement[] = [];
  const guestErrors: string[] = [];
  afterEach(async () => {
    await act(async () => {
      for (const frame of frames.splice(0)) {
        frame.contentWindow?.dispatchEvent(new Event("pagehide"));
        await Promise.resolve();
        frame.remove();
      }
      await Promise.resolve();
    });
    expect(guestErrors.splice(0)).toEqual([]);
  });
  const fragment = `<section id="chart" aria-label="Chart"><button id="counter">Count</button></section><button id="outside">Outside</button><div class="viz-carousel" id="variants"><section data-variant="Bars" id="bars"></section><section data-variant="Dots" id="dots" hidden></section></div><script>
window.settings={radius:10,color:'#112233',details:true,density:'compact'};window.count=0;
document.getElementById('counter').onclick=()=>window.count++;
new Tweak({container:document.getElementById('chart'),onChange:()=>document.getElementById('chart').dataset.preview=JSON.stringify(settings)}).addSlider(settings,'radius',{min:0,max:100}).addColorPicker(settings,'color').addToggle(settings,'details').addSelect(settings,'density',{options:['compact','relaxed']});
new Tweak({container:document.getElementById('bars')}).addSlider({size:3},'size',{min:0,max:10});
new Tweak({container:document.getElementById('dots')}).addSlider({size:5},'size',{min:0,max:10});
</script>`;

  function mount(allowed = true, authored = fragment) {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frames.push(frame);
    const guest = frame.contentWindow! as Window &
      typeof globalThis & {
        openai: { callTool: (name: string, input: unknown) => Promise<unknown> };
        settings: Record<string, unknown>;
        count: number;
      };
    guest.Range.prototype.getBoundingClientRect = () => new guest.DOMRect();
    guest.addEventListener("error", (event) => {
      guestErrors.push(event.message);
      event.preventDefault();
    });
    const owner = createInlineVisualizationAnnotations({
      allowed,
      globals: (command: VisualizationAnnotationCommand | null) =>
        guest.dispatchEvent(
          new guest.CustomEvent("openai:set_globals", {
            detail: { globals: { visualizationAnnotation: command } },
          }),
        ),
    });
    Object.assign(guest, {
      openai: {
        callTool: async (name: string, value: unknown) =>
          name === VISUALIZATION_ANNOTATION_TOOL ? owner.handleMessage(value) : undefined,
      },
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    });
    guest.document.open();
    guest.document.write(
      buildInlineVisualizationDocument(
        allowed ? authored : '<div class="viz-carousel" id="variants"></div>',
        { allowAnnotations: allowed },
      ),
    );
    guest.document.close();
    owner.setPresentation({ active: true, ready: true, preview: false });
    return { guest, owner };
  }
  test("Tweak accepts all four bindings before authored code, previews and restores real objects, and intercepts only editing target clicks", async () => {
    const { guest, owner } = mount();
    await waitFor(() => expect(owner.getSnapshot().rows[0]?.controls.controls).toHaveLength(4));
    await act(async () => {
      owner.open();
      owner.change("tweak-1-1", 40);
      owner.change("tweak-1-2", "#aabbcc");
      owner.change("tweak-1-3", false);
      owner.change("tweak-1-4", "relaxed");
      await Promise.resolve();
    });
    expect(guest.settings).toEqual({
      radius: 40,
      color: "#aabbcc",
      details: false,
      density: "relaxed",
    });
    const counter = guest.document.getElementById("counter")!;
    await act(async () => {
      counter.dispatchEvent(
        new guest.MouseEvent("click", {
          bubbles: true,
          composed: true,
          cancelable: true,
          button: 0,
        }),
      );
      await Promise.resolve();
    });
    expect(guest.count).toBe(0);
    await act(async () => {
      owner.reset();
      await Promise.resolve();
    });
    expect(guest.settings.radius).toBe(10);
    await act(async () => {
      guest.document
        .getElementById("outside")!
        .dispatchEvent(
          new guest.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
      await Promise.resolve();
    });
    expect(owner.getSnapshot().open).toBe(false);
    await act(async () => {
      counter.dispatchEvent(
        new guest.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
      );
      await Promise.resolve();
    });
    expect(guest.count).toBe(1);
  });
  test("carousel variants work without Tweak and removal clears their model context", async () => {
    const { guest, owner } = mount(false);
    await act(async () => {
      guest.document.getElementById("variants")!.setAttribute("data-active-variant", "Dots");
      await Promise.resolve();
    });
    expect(owner.getSnapshot().rows).toHaveLength(0);
    expect(owner.getSnapshot().visible).toBe(false);
    await act(async () => {
      guest.document.getElementById("variants")!.remove();
      await Promise.resolve();
    });
    expect(owner.getSnapshot().hasEdits).toBe(false);
  });
  test("hidden carousel targets update eligibility without losing an accepted registration", async () => {
    const { guest, owner } = mount();
    await waitFor(() => expect(owner.getSnapshot().rows).toHaveLength(3));
    expect(owner.getSnapshot().rows.map((row) => row.visible)).toEqual([true, true, false]);
    await act(async () => {
      guest.document.getElementById("bars")!.hidden = true;
      guest.document.getElementById("dots")!.hidden = false;
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(owner.getSnapshot().rows.map((row) => row.visible)).toEqual([true, false, true]),
    );
    await act(async () => {
      guest.document.getElementById("chart")!.remove();
      await Promise.resolve();
    });
    await waitFor(() => expect(owner.getSnapshot().rows).toHaveLength(2));
  });
  test("a rejected authored binding cannot change the first accepted control's callback identity", async () => {
    const { guest, owner } = mount(
      true,
      `<section id="chart"></section><script>
  window.settings={details:true};
  const panel=new Tweak({container:document.getElementById('chart')});
  try{panel.addSlider({radius:200},'radius',{min:0,max:100})}catch{}
  panel.addToggle(settings,'details');
  </script>`,
    );
    await waitFor(() => expect(owner.getSnapshot().rows[0]?.controls.controls).toHaveLength(1));
    await act(async () => {
      owner.open();
      owner.change("tweak-1-1", false);
      await Promise.resolve();
    });
    expect(guest.settings.details).toBe(false);
  });
});

describe("inline visualization document", () => {
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
    const callTool = vi.fn<(name: string, value: unknown) => Promise<unknown>>(
      async () => undefined,
    );
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
      // The guest owns its globals. Drive its clock with the test's fake timers.
      Date: globalThis.Date,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
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
      expect(guest.document.getElementById("panel-b")!.getAttribute("aria-labelledby")).toBe(
        "tab-b",
      );
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
});

describe("inline visualization frame owner", () => {
  const roots: HTMLElement[] = [];
  afterEach(() => roots.splice(0).forEach((root) => root.remove()));
  function element() {
    const value = document.createElement("div");
    document.body.append(value);
    roots.push(value);
    return value;
  }
  function harness() {
    const jobs: (() => void)[] = [];
    const owner = createInlineVisualizationFrameOwner({
      createContainer: () => document.createElement("div"),
      createId: () => crypto.randomUUID(),
      move: (child, parent) => parent.append(child),
      schedule: (job) => jobs.push(job),
    });
    const parking = element();
    owner.setParking(parking);
    return { owner, parking, flush: () => jobs.splice(0).forEach((job) => job()) };
  }
  function input(
    threadId = "a",
    changes: Partial<InlineVisualizationFrameInput> = {},
  ): InlineVisualizationFrameInput {
    return {
      identity: {
        surfaceId: "main",
        hostId: "local",
        readHostId: "remote-source",
        threadId,
        sourceThreadId: "source",
        file: "report.html",
        occurrence: "native-receipt",
      },
      fragment: { contents: "<button>Counter</button>", path: "/source/report.html" },
      stateIdentity: { hostId: "local", threadId, path: "/source/report.html" },
      attempt: 0,
      canExpand: true,
      retry: vi.fn(),
      followUp: vi.fn(async () => {}),
      submitAnnotations: vi.fn(async () => {}),
      ...changes,
    };
  }
  function runtime(): InlineVisualizationRuntime {
    return {
      element: document.createElement("div"),
      getSnapshot: () => ({
        status: "ready",
        height: 240,
        fullscreenHeight: null,
        displayMode: "inline",
        error: null,
      }),
      subscribe: () => () => {},
      setDisplayMode: vi.fn(),
      captureImage: vi.fn(async () => new Uint8Array()),
      copyAsImage: vi.fn(async () => {}),
      setActive: vi.fn(),
      dispose: vi.fn(async () => {}),
      annotations: createInlineVisualizationAnnotations({ allowed: true, globals: () => {} }),
    };
  }

  describe("window-owned interactive response occurrences", () => {
    test("same-commit rebind preserves one runtime and stale cleanup cannot release its new anchor", () => {
      const { owner, flush } = harness();
      owner.setSurface("main", "local", "a");
      const first = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(first.frameId, guest);
      owner.unbind(first);
      const anchor = element();
      const second = owner.bind(input(), anchor);
      owner.unbind(first);
      flush();
      expect(second.frameId).toBe(first.frameId);
      expect(owner.readFrame(second.frameId)?.container.parentElement).toBe(anchor);
      expect(owner.isActive(second.frameId)).toBe(true);
      expect(guest.dispose).not.toHaveBeenCalled();
      owner.dispose();
    });
    test("two connected consumers of one occurrence isolate runtime lifetime", () => {
      const { owner, flush } = harness();
      owner.setSurface("main", "local", "a");
      const first = owner.bind(input(), element());
      const second = owner.bind(input(), element());
      const one = runtime();
      const two = runtime();
      owner.attachRuntime(first.frameId, one);
      owner.attachRuntime(second.frameId, two);
      expect(first.frameId).not.toBe(second.frameId);
      owner.unbind(first);
      flush();
      expect(one.dispose).toHaveBeenCalledOnce();
      expect(two.dispose).not.toHaveBeenCalled();
      expect(owner.readIds()).toEqual([second.frameId]);
      owner.dispose();
    });
    test("A-B-A parks the document, denies inactive actions, then binds the original frame and current callback", async () => {
      const { owner, parking, flush } = harness();
      owner.reportHistory("local", "a", true);
      owner.setSurface("main", "local", "a");
      const first = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(first.frameId, guest);
      owner.acceptHeight(first.frameId, 0, 430.2);
      owner.setSurface("main", "local", "b");
      owner.unbind(first);
      flush();
      expect(owner.readFrame(first.frameId)?.container.parentElement).toBe(parking);
      expect(owner.readFrame(first.frameId)?.container.inert).toBe(true);
      expect(() => owner.followUp(first.frameId, { sourceId: "test", prompt: "Late" })).toThrow(
        "unavailable",
      );
      const send = vi.fn(async () => {});
      owner.setSurface("main", "local", "a");
      const second = owner.bind(input("a", { followUp: send }), element());
      await owner.followUp(second.frameId, { sourceId: "test", prompt: "Current" });
      expect(second.frameId).toBe(first.frameId);
      expect(send).toHaveBeenCalledOnce();
      expect(owner.readFrame(second.frameId)?.initialHeight).toBe(431);
      expect(guest.dispose).not.toHaveBeenCalled();
      owner.dispose();
    });
    test("true unmount in the current Thread retires the frame after its rebind window", () => {
      const { owner, flush } = harness();
      owner.setSurface("main", "local", "a");
      const binding = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(binding.frameId, guest);
      owner.unbind(binding);
      expect(guest.dispose).not.toHaveBeenCalled();
      flush();
      expect(guest.dispose).toHaveBeenCalledOnce();
      expect(owner.readIds()).toEqual([]);
      owner.dispose();
    });
    test("leaving an unbound selected Thread retires its already invalidated history", () => {
      const { owner, flush } = harness();
      owner.reportHistory("local", "a", true);
      owner.setSurface("main", "local", "a");
      const binding = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(binding.frameId, guest);
      owner.setSurface("main", "local", "b");
      owner.unbind(binding);
      flush();
      owner.setSurface("main", "local", "a");
      owner.reportHistory("local", "a", false);
      flush();
      expect(guest.dispose).not.toHaveBeenCalled();
      owner.setSurface("main", "local", "b");
      expect(guest.dispose).toHaveBeenCalledOnce();
      expect(owner.readIds()).toEqual([]);
      owner.dispose();
    });
    test("inactive detached frame is released when its Thread history is invalidated", () => {
      const { owner, flush } = harness();
      owner.setSurface("main", "local", "a");
      const binding = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(binding.frameId, guest);
      owner.setSurface("main", "local", "b");
      owner.reportHistory("local", "a", false);
      expect(guest.dispose).not.toHaveBeenCalled();
      owner.unbind(binding);
      flush();
      expect(guest.dispose).toHaveBeenCalledOnce();
      owner.dispose();
    });
    test("height is tied weakly to body contents and rejects stale document generations", () => {
      const { owner } = harness();
      owner.setSurface("main", "local", "a");
      const binding = owner.bind(input(), element());
      const original = owner.readFrame(binding.frameId)!.fragment;
      owner.acceptHeight(binding.frameId, 0, 300.1);
      owner.updateBinding(binding, input());
      expect(owner.readFrame(binding.frameId)?.fragment).toBe(original);
      expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(301);
      owner.updateBinding(
        binding,
        input("a", { fragment: { contents: "<p>New body</p>", path: "/source/report.html" } }),
      );
      expect(owner.readFrame(binding.frameId)?.documentRevision).toBe(1);
      expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(240);
      owner.acceptHeight(binding.frameId, 0, 999);
      owner.acceptHeight(binding.frameId, 1, Number.NaN);
      expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(240);
      owner.acceptHeight(binding.frameId, 1, 100_000);
      expect(owner.readFrame(binding.frameId)?.initialHeight).toBe(10_000);
      owner.dispose();
    });
    test("an explicit retry replaces its runtime and stays distinct from a first standby claim", () => {
      const { owner } = harness();
      owner.setSurface("main", "local", "a");
      const binding = owner.bind(input(), element());
      const guest = runtime();
      owner.attachRuntime(binding.frameId, guest);
      owner.acceptHeight(binding.frameId, 0, 320);
      owner.updateBinding(binding, input("a", { attempt: 1 }));
      expect(guest.dispose).toHaveBeenCalledOnce();
      expect(owner.readFrame(binding.frameId)).toMatchObject({
        attempt: 1,
        documentRevision: 1,
        initialHeight: 320,
      });
      owner.updateBinding(binding, input("a", { attempt: 1 }));
      expect(guest.dispose).toHaveBeenCalledOnce();
      expect(owner.readFrame(binding.frameId)?.documentRevision).toBe(1);
      owner.dispose();
    });
    test("accepted deletion is host-scoped and disposal cannot be undone by queued cleanup", () => {
      const { owner, flush } = harness();
      const local = input();
      const remote = input("a", { identity: { ...local.identity, hostId: "remote" } });
      const first = owner.bind(local, element());
      const second = owner.bind(remote, element());
      owner.unbind(first);
      owner.releaseThread("local", "a");
      expect(owner.readIds()).toEqual([second.frameId]);
      expect(owner.readPlaceholder(local.identity)).toBeUndefined();
      owner.dispose();
      flush();
      expect(owner.readIds()).toEqual([]);
      expect(() => owner.bind(local, element())).toThrow("closed");
    });
  });
});

describe("inline visualization standby", () => {
  type Job = {
    readonly kind: "idle" | "delay" | "paint";
    readonly duration?: number;
    canceled: boolean;
    readonly run: () => void;
  };
  function scheduler() {
    const jobs: Job[] = [];
    const schedule = (kind: Job["kind"], run: () => void, duration?: number) => {
      const job = { kind, run, duration, canceled: false };
      jobs.push(job);
      return () => {
        job.canceled = true;
      };
    };
    const next = () => {
      const job = jobs.shift();
      if (!job) throw new Error("Expected a scheduled background phase");
      if (!job.canceled) job.run();
      return job;
    };
    return {
      jobs,
      next,
      idle: (run: () => void) => schedule("idle", run),
      delay: (run: () => void, duration: number) => schedule("delay", run, duration),
      paint: (run: () => void) => schedule("paint", run),
    };
  }
  function harness() {
    const clock = scheduler();
    const leases: Array<{ readonly lease: InlineVisualizationPreparedLease; ready: () => void }> =
      [];
    const container = document.createElement("div");
    document.body.append(container);
    const standby = createInlineVisualizationStandby({
      idle: clock.idle,
      delay: clock.delay,
      prepare: (locale, onDispose) => {
        let ready = false;
        let disposed = false;
        const element = document.createElement("webview");
        const lease: InlineVisualizationPreparedLease = {
          locale,
          element,
          get identity(): InlineVisualizationPreparedLease["identity"] {
            throw new Error("The fake broker lease has no native identity");
          },
          get isReady() {
            return ready && !disposed;
          },
          presentationRevision: 1,
          prepare: vi.fn(async (parent) => {
            parent.append(element);
          }),
          activate: vi.fn(async () => {
            throw new Error("This fixture exercises only broker ownership");
          }),
          dispose: vi.fn(async () => {
            if (disposed) return;
            disposed = true;
            element.remove();
            onDispose(lease);
          }),
        };
        leases.push({
          lease,
          ready: () => {
            ready = true;
          },
        });
        return lease;
      },
    });
    return {
      clock,
      container,
      leases,
      standby,
      close: () => {
        standby.dispose();
        container.remove();
      },
    };
  }
  const closers: (() => void)[] = [];
  afterEach(() => {
    closers.splice(0).forEach((close) => close());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("window-owned blank sandbox standby", () => {
    test("warming claims are empty, ready claim transfers one guest and replenishes once", () => {
      const value = harness();
      closers.push(value.close);
      value.standby.start(value.container, "en-US");
      expect(value.clock.jobs).toHaveLength(1);
      expect(value.standby.claim("en-US")).toBeNull();
      value.clock.next();
      const first = value.leases[0]!;
      expect(value.standby.claim("en-US")).toBeNull();
      expect(value.leases).toHaveLength(1);
      first.ready();
      expect(value.standby.claim("en-US")).toBe(first.lease);
      expect(value.clock.jobs).toHaveLength(1);
      value.clock.next();
      expect(value.leases).toHaveLength(2);
      value.standby.dispose();
      expect(first.lease.dispose).not.toHaveBeenCalled();
      expect(value.leases[1]!.lease.dispose).toHaveBeenCalledOnce();
      void first.lease.dispose();
    });
    test("one preparation retry belongs to the root, including a mismatching locale claim", () => {
      const value = harness();
      closers.push(value.close);
      value.standby.start(value.container, "en-US");
      value.clock.next();
      value.leases[0]!.ready();
      expect(value.standby.claim("zh-CN")).toBeNull();
      expect(value.clock.jobs[0]).toMatchObject({ kind: "delay", duration: 1_000 });
      value.clock.next();
      void value.leases[1]!.lease.dispose();
      expect(value.clock.jobs).toHaveLength(0);
      // A later demand may prepare; failure never causes a self-sustaining retry loop.
      expect(value.standby.claim("en-US")).toBeNull();
      expect(value.clock.jobs[0]?.kind).toBe("idle");
    });
    test("stale root stop and late disposal cannot retire the replacement or a claimed guest", () => {
      const value = harness();
      closers.push(value.close);
      const stopOld = value.standby.start(value.container, "en-US");
      value.clock.next();
      const first = value.leases[0]!;
      first.ready();
      value.standby.claim("en-US");
      value.standby.start(value.container, "zh-CN");
      stopOld();
      void first.lease.dispose();
      while (value.clock.jobs.length) value.clock.next();
      expect(value.leases).toHaveLength(2);
      expect(value.leases[1]!.lease.locale).toBe("zh-CN");
      expect(value.leases[1]!.lease.dispose).not.toHaveBeenCalled();
    });
    test("paint, five seconds, two distinct idle phases; locale and pagehide cancel their own root", () => {
      const value = harness();
      closers.push(value.close);
      let locale = "en-US";
      let changeLocale: (() => void) | null = null;
      let pageHide: (() => void) | null = null;
      const stop = startInlineVisualizationPrewarmer(value.container, value.standby, {
        afterVisiblePaint: value.clock.paint,
        delay: value.clock.delay,
        idle: value.clock.idle,
        readLocale: () => locale,
        onLocaleChange: (callback) => {
          changeLocale = callback;
          return () => {
            changeLocale = null;
          };
        },
        onPageHide: (callback) => {
          pageHide = callback;
          return () => {
            pageHide = null;
          };
        },
      });
      expect(value.clock.next().kind).toBe("paint");
      expect(value.clock.jobs[0]).toMatchObject({ kind: "delay", duration: 5_000 });
      locale = "zh-CN";
      changeLocale!();
      value.clock.next();
      expect(value.clock.next().kind).toBe("idle");
      expect(value.leases).toHaveLength(0);
      expect(value.clock.next().kind).toBe("idle");
      expect(value.leases[0]!.lease.locale).toBe("zh-CN");
      locale = "de-DE";
      changeLocale!();
      expect(value.leases[0]!.lease.dispose).toHaveBeenCalledOnce();
      expect(value.clock.jobs[0]?.kind).toBe("idle");
      pageHide!();
      stop();
      value.clock.next();
      expect(value.leases).toHaveLength(1);
      expect(changeLocale).toBeNull();
      expect(pageHide).toBeNull();
    });
    test("idle admission requires both APIs, and cancellation preserves the scheduled identity", () => {
      vi.useFakeTimers();
      const execute = vi.fn();
      const request = vi.fn(() => 19);
      const cancel = vi.fn();
      vi.stubGlobal("requestIdleCallback", request);
      vi.stubGlobal("cancelIdleCallback", undefined);
      const cancelFallback = scheduleInlineVisualizationIdle(execute);
      expect(request).not.toHaveBeenCalled();
      cancelFallback();
      vi.runAllTimers();
      expect(execute).not.toHaveBeenCalled();
      vi.stubGlobal("cancelIdleCallback", cancel);
      const cancelIdle = scheduleInlineVisualizationIdle(execute);
      expect(request).toHaveBeenCalledWith(execute, { timeout: 2_000 });
      cancelIdle();
      expect(cancel).toHaveBeenCalledWith(19);
    });
  });
});

describe("inline visualization widget state", () => {
  const identity = { hostId: "local", threadId: "display", path: "/raw/plot.html" };
  const owner = (): InlineVisualizationWidgetStateOwner => ({
    identity,
    read: vi.fn(async () => null),
    writeInteraction: vi.fn(),
    write: vi.fn<InlineVisualizationWidgetStateOwner["write"]>(async (value) => ({
      ok: true,
      revision: 1,
      value,
    })),
  });

  describe("file widget state admission", () => {
    test("keeps absolute attributes as the API path and uses resolved paths only for bare files", () => {
      expect(
        resolveInlineVisualizationStateIdentity({
          ...identity,
          file: "/var/plot.html",
          resolvedPath: "/private/var/plot.html",
        }),
      ).toEqual({ ...identity, path: "/var/plot.html" });
      expect(
        resolveInlineVisualizationStateIdentity({
          ...identity,
          file: "plot.html",
          resolvedPath: "/owned/plot.html",
        }),
      ).toEqual({ ...identity, path: "/owned/plot.html" });
      expect(
        resolveInlineVisualizationStateIdentity({
          ...identity,
          file: "plot.html",
          resolvedPath: null,
        }),
      ).toBeNull();
    });
    test("admits only the fixed widget and normalizes legal state before the semantic write", async () => {
      const stateOwner = owner();
      const controller = new AbortController();
      const handler = createInlineVisualizationStateUpdateHandler({
        owner: stateOwner,
        widgetId: identity.path,
        signal: controller.signal,
      });
      expect(await handler("forged", { selected: 3 })).toEqual({ ok: false, retryable: false });
      expect(await handler(identity.path, { imageIds: ["unsupported"] })).toMatchObject({
        ok: false,
        code: "images_unsupported",
      });
      expect(stateOwner.write).not.toHaveBeenCalled();
      expect(await handler(identity.path, { selected: 3 })).toBeUndefined();
      expect(stateOwner.write).toHaveBeenCalledWith({
        modelContent: null,
        privateContent: null,
        selected: 3,
      });
      controller.abort();
      expect(await handler(identity.path, { selected: 4 })).toEqual({
        ok: false,
        retryable: false,
      });
      expect(stateOwner.write).toHaveBeenCalledOnce();
    });
    test("returns explicit persistence failure and rejects disabled interactions", async () => {
      const stateOwner = owner();
      vi.mocked(stateOwner.write).mockRejectedValueOnce(new Error("Storage unavailable"));
      let enabled = true;
      const handler = createInlineVisualizationStateUpdateHandler({
        owner: stateOwner,
        widgetId: identity.path,
        signal: new AbortController().signal,
        allowInteractions: () => enabled,
      });
      expect(await handler(identity.path, {})).toEqual({
        ok: false,
        code: "storage_unavailable",
        retryable: false,
      });
      enabled = false;
      expect(await handler(identity.path, {})).toEqual({ ok: false, retryable: false });
      expect(stateOwner.write).toHaveBeenCalledOnce();
    });
  });
});
