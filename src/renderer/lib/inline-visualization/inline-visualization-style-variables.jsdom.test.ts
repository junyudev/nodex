import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { applyCodexThemeVariant } from "../codex-theme-variant";
import { applySansFontSizeRootVariables } from "../sans-font-size";
import {
  createInlineVisualizationRuntime,
  type InlineVisualizationRuntime,
} from "./inline-visualization-runtime";
import type { connectMcpAppSandbox, McpAppSkybridgeApi } from "../mcp-app/mcp-app-port-rpc";

type ConnectInput = Parameters<typeof connectMcpAppSandbox>[0];
const boundary = vi.hoisted(() => ({
  connect:
    vi.fn<
      (input: ConnectInput) => Promise<import("../mcp-app/mcp-app-port-rpc").ConnectedMcpAppSandbox>
    >(),
}));
vi.mock("../mcp-app/mcp-app-port-rpc", () => ({ connectMcpAppSandbox: boundary.connect }));
vi.mock("../renderer-command", () => ({
  defineRendererCommand: (input: unknown) => input,
  invokeRendererControl: async () => true,
}));

type GuestWindow = Window &
  typeof globalThis & {
    openai: Record<string, unknown>;
    initialStyles: { readonly size: string; readonly font: string; readonly persistence: unknown };
  };
const guests: HTMLIFrameElement[] = [];
const runtimes: InlineVisualizationRuntime[] = [];
const runs = vi.fn();
const globalsSent = vi.fn();
const hostContextsSent = vi.fn();
const themesSent = vi.fn();
let rootStyle = "";
let rootClass = "";
let bodyStyle = "";
let bodyClass = "";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a native API object");
  return value as Record<string, unknown>;
}

beforeEach(() => {
  rootStyle = document.documentElement.getAttribute("style") ?? "";
  rootClass = document.documentElement.className;
  bodyStyle = document.body.getAttribute("style") ?? "";
  bodyClass = document.body.className;
  runs.mockClear();
  globalsSent.mockClear();
  hostContextsSent.mockClear();
  themesSent.mockClear();
  boundary.connect.mockImplementation(async (input) => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    guests.push(frame);
    const guest = frame.contentWindow as GuestWindow;
    const globals: Record<string, unknown> = {};
    const update = async (value: Parameters<McpAppSkybridgeApi["setAdditionalGlobals"]>[0]) => {
      Object.assign(globals, record(record(value).additionalGlobals));
      globalsSent(value);
      if (!guest.openai) return;
      Object.assign(guest.openai, globals);
      guest.dispatchEvent(new guest.CustomEvent("openai:set_globals", { detail: { globals } }));
    };
    const control = vi.fn(async () => undefined);
    const api: McpAppSkybridgeApi = {
      navigate: control,
      notifyMcpAppsHostContext: async (value) => {
        hostContextsSent(value);
      },
      notifyMcpAppsMcpNotification: null,
      notifyMcpAppsToolCancelled: control,
      notifyMcpAppsToolInput: control,
      notifyMcpAppsToolResult: control,
      requestMcpAppsResourceTeardown: control,
      setAdditionalGlobals: update,
      setSafeArea: control,
      setTheme: async (value) => {
        themesSent(value);
      },
      setWidgetData: control,
      setWidgetView: control,
      runWidgetCode: (value) =>
        (async function* () {
          runs(value);
          guest.openai = {
            ...globals,
            callTool: async (name: string, args: unknown) => input.handlers.callTool(name, args),
          };
          guest.ResizeObserver = class {
            observe() {}
            disconnect() {}
          } as unknown as typeof ResizeObserver;
          guest.HTMLElement.prototype.getBoundingClientRect = () =>
            new guest.DOMRect(0, 0, 300, 40);
          guest.document.open();
          const html = record(value).html;
          if (typeof html !== "string") throw new Error("Expected an authored document");
          guest.document.write(html);
          guest.document.close();
          yield { type: "environment_status", status: 2 };
        })(),
    };
    return { api, dispose: () => {}, initId: "style-attempt" };
  });
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const frame of guests.splice(0)) {
    const guest = frame.contentWindow as GuestWindow;
    guest.dispatchEvent(new guest.Event("pagehide"));
    frame.remove();
  }
  document.documentElement.setAttribute("style", rootStyle);
  document.documentElement.className = rootClass;
  document.body.setAttribute("style", bodyStyle);
  document.body.className = bodyClass;
});

function mount() {
  const runtime = createInlineVisualizationRuntime({
    scopeId: "style-runtime",
    html: `<p>Styles</p><script>window.initialStyles={size:document.documentElement.style.getPropertyValue('--font-size-base'),font:document.documentElement.style.getPropertyValue('--font-sans'),persistence:window.openai.statePersistence};</script>`,
  });
  document.body.append(runtime.element);
  runtimes.push(runtime);
  return runtime;
}

test("actual host typography preferences reach the authored document on first execution and update the retained guest", async () => {
  document.documentElement.className = "";
  applyCodexThemeVariant(document.documentElement, "light", document.body);
  applySansFontSizeRootVariables(document.documentElement, 18);
  document.documentElement.style.setProperty("--font-sans", "Preferred Sans, serif");
  document.documentElement.style.setProperty("--font-mono", "Preferred Mono, monospace");
  document.documentElement.style.setProperty("--radius-lg", "14px");
  document.documentElement.style.setProperty("--spacing-button-toolbar-inline", "16px");
  mount();
  await waitFor(() => expect(runs).toHaveBeenCalledOnce());
  const frame = guests[0]!;
  const guest = frame.contentWindow as GuestWindow;
  expect(guest.initialStyles).toEqual({
    size: "18px",
    font: "Preferred Sans, serif",
    persistence: "none",
  });
  const sent = globalsSent.mock.calls.at(-1)?.[0].additionalGlobals.visualizationStyleVariables;
  expect(sent).toMatchObject({
    "--font-mono": "Preferred Mono, monospace",
    "--radius": "14px",
    "--control-spacing": "16px",
    "--cursor-interaction": "pointer",
    "--visualize-paint-gutter": "5px",
  });
  expect(document.body.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  await act(async () => {
    applySansFontSizeRootVariables(document.documentElement, 20);
    document.documentElement.style.setProperty("--radius-lg", "18px");
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(guest.document.documentElement.style.getPropertyValue("--font-size-base")).toBe("20px"),
  );
  expect(guest.document.documentElement.style.getPropertyValue("--radius")).toBe("18px");
  await act(async () => {
    document.body.style.setProperty("--cursor-interaction", "default");
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(guest.document.documentElement.style.getPropertyValue("--cursor-interaction")).toBe(
      "default",
    ),
  );
  expect(guests[0]).toBe(frame);
  expect(runs).toHaveBeenCalledOnce();
});

test("a real host appearance change updates semantic colors and accent-derived chart hues in the same document", async () => {
  document.documentElement.className = "";
  applyCodexThemeVariant(document.documentElement, "light", document.body);
  mount();
  await waitFor(() => expect(runs).toHaveBeenCalledOnce());
  const guest = guests[0]!.contentWindow as GuestWindow;
  const light = globalsSent.mock.calls.at(-1)?.[0].additionalGlobals.visualizationStyleVariables;
  await act(async () => {
    applyCodexThemeVariant(document.documentElement, "dark", document.body);
    document.documentElement.classList.add("dark");
    document.documentElement.style.setProperty("--color-text-accent", "#df5142");
    await Promise.resolve();
  });
  await waitFor(() => expect(guest.document.documentElement.dataset.theme).toBe("dark"));
  const dark = globalsSent.mock.calls.at(-1)?.[0].additionalGlobals.visualizationStyleVariables;
  expect(dark).toMatchObject({
    "--background": "#111111",
    "--primary": "#df5142",
    "--viz-series-1": "#df5142",
    "--orange": "#fb6a22",
    "--green": "#40c977",
    "--red": "#ff6764",
  });
  expect(dark["--viz-series-2"]).not.toBe(light["--viz-series-2"]);
  expect(
    new Set(Array.from({ length: 6 }, (_, index) => dark[`--viz-series-${index + 1}`])).size,
  ).toBe(6);
  expect(runs).toHaveBeenCalledOnce();
});

test("drag and layout presentation changes send no widget context while fractional typography and cursor preferences update the same guest", async () => {
  document.documentElement.className = "";
  applyCodexThemeVariant(document.documentElement, "light", document.body);
  applySansFontSizeRootVariables(document.documentElement, 18);
  const runtime = mount();
  await waitFor(() => expect(runtime.getSnapshot().status).toBe("ready"));
  const frame = guests[0]!;
  const guest = frame.contentWindow as GuestWindow;
  globalsSent.mockClear();
  hostContextsSent.mockClear();
  themesSent.mockClear();
  const computedStyles = vi.spyOn(window, "getComputedStyle");
  try {
    await act(async () => {
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.body.style.paddingLeft = "12px";
      await Promise.resolve();
    });
    expect(globalsSent).not.toHaveBeenCalled();
    expect(hostContextsSent).not.toHaveBeenCalled();
    expect(themesSent).not.toHaveBeenCalled();
    expect(computedStyles).not.toHaveBeenCalled();
    await act(async () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("padding-left");
      document.body.classList.add("workbench-dragging");
      document.documentElement.classList.add("workbench-layout-changing");
      document.documentElement.style.marginLeft = "4px";
      await Promise.resolve();
    });
    expect(globalsSent).not.toHaveBeenCalled();
    expect(hostContextsSent).not.toHaveBeenCalled();
    expect(themesSent).not.toHaveBeenCalled();
    await act(async () => {
      document.documentElement.style.setProperty("--sans-font-size", "18.5px");
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(guest.document.documentElement.style.getPropertyValue("--font-size-base")).toBe(
        "18.5px",
      ),
    );
    expect(globalsSent).toHaveBeenCalledOnce();
    expect(hostContextsSent).toHaveBeenCalledOnce();
    expect(themesSent).toHaveBeenCalledOnce();
    await act(async () => {
      document.body.style.setProperty("--cursor-interaction", "default");
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(guest.document.documentElement.style.getPropertyValue("--cursor-interaction")).toBe(
        "default",
      ),
    );
    expect(globalsSent).toHaveBeenCalledTimes(2);
    expect(hostContextsSent).toHaveBeenCalledTimes(2);
    expect(themesSent).toHaveBeenCalledTimes(2);
    expect(guests[0]).toBe(frame);
    expect(runs).toHaveBeenCalledOnce();
  } finally {
    computedStyles.mockRestore();
  }
});

test("native resize callbacks publish only changed content width and are fenced after disposal", async () => {
  const observers: ResizeObserver[] = [];
  let resizeCallback!: ResizeObserverCallback;
  const disconnect = vi.fn();
  class RuntimeResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
      observers.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect = disconnect;
  }
  vi.stubGlobal("ResizeObserver", RuntimeResizeObserver);
  try {
    const runtime = mount();
    let width = 510;
    let height = 150;
    Object.defineProperties(runtime.element, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
    });
    await waitFor(() => expect(runtime.getSnapshot().status).toBe("ready"));
    expect(globalsSent.mock.calls.at(-1)?.[0].additionalGlobals.maxWidth).toBe(500);
    expect(hostContextsSent.mock.calls.at(-1)?.[0].hostContext.containerDimensions.maxWidth).toBe(
      500,
    );
    globalsSent.mockClear();
    hostContextsSent.mockClear();
    themesSent.mockClear();
    const observer = observers[0]!;
    await act(async () => {
      resizeCallback([], observer);
      height = 688;
      resizeCallback([], observer);
      await Promise.resolve();
    });
    expect(globalsSent).not.toHaveBeenCalled();
    expect(hostContextsSent).not.toHaveBeenCalled();
    expect(themesSent).not.toHaveBeenCalled();
    await act(async () => {
      width = 610;
      resizeCallback([], observer);
      resizeCallback([], observer);
      await Promise.resolve();
    });
    expect(globalsSent).toHaveBeenCalledOnce();
    expect(hostContextsSent).toHaveBeenCalledOnce();
    expect(themesSent).toHaveBeenCalledOnce();
    expect(globalsSent.mock.calls[0]?.[0].additionalGlobals.maxWidth).toBe(600);
    expect(hostContextsSent.mock.calls[0]?.[0].hostContext.containerDimensions.maxWidth).toBe(600);
    await act(async () => {
      runtime.setDisplayMode("inline");
      await Promise.resolve();
    });
    expect(globalsSent).toHaveBeenCalledTimes(2);
    expect(hostContextsSent).toHaveBeenCalledTimes(2);
    expect(themesSent).toHaveBeenCalledTimes(2);
    await act(async () => {
      resizeCallback([], observer);
      await runtime.dispose();
      width = 710;
      resizeCallback([], observer);
      await Promise.resolve();
    });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(globalsSent).toHaveBeenCalledTimes(2);
    expect(hostContextsSent).toHaveBeenCalledTimes(2);
    expect(themesSent).toHaveBeenCalledTimes(2);
    expect(runs).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
