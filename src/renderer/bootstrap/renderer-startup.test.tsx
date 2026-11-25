import { StrictMode, act, lazy, useState, type ComponentType, type ReactNode } from "react";
import {
  render,
  screen,
  act as actForAuxiliaryWindowAppearance,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi, beforeEach } from "vite-plus/test";
import {
  ApplicationReadinessRoot,
  ApplicationSurface,
  createApplicationReadiness,
  useApplicationReady,
} from "./application-surface";
import { THEME_STORAGE_KEY, writeThemePreference } from "../lib/theme-preferences";
import {
  TYPOGRAPHY_STORAGE_KEY,
  readTypographyPreferences,
  writeTypographyPreferences,
} from "../lib/typography-preferences";
import { AuxiliaryWindowAppearance } from "./auxiliary-window-appearance";
import { installWindowApi } from "../test/browser-globals";
import { initializeRendererDocument } from "./renderer-document";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

describe("application surface", () => {
  function deferredSurface() {
    let resolve = (_module: { default: ComponentType }): void => undefined;
    let reject = (_error: unknown): void => undefined;
    const module = new Promise<{ default: ComponentType }>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const load = vi.fn(() => module);
    return { View: lazy(load), resolve, reject, load };
  }

  function Workbench({
    ready = true,
    children,
  }: {
    readonly ready?: boolean;
    readonly children: ReactNode;
  }) {
    useApplicationReady(ready);
    return children;
  }

  function Counter() {
    const [count, setCount] = useState(0);
    return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
  }

  function observeReadiness() {
    const readiness = createApplicationReadiness();
    const success = vi.fn();
    const failure = vi.fn();
    void readiness.ready.then(success, failure);
    return { readiness, success, failure };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "api");
  });

  describe("application surface readiness", () => {
    test("waits for the ordinary loading branch, including an empty Workbench", async () => {
      const { readiness, success } = observeReadiness();
      const view = render(
        <ApplicationReadinessRoot readiness={readiness}>
          <Workbench ready={false}>
            <span role="status">Loading</span>
          </Workbench>
        </ApplicationReadinessRoot>,
      );
      await act(async () => Promise.resolve());
      expect(success).not.toHaveBeenCalled();

      await act(async () => {
        view.rerender(
          <ApplicationReadinessRoot readiness={readiness}>
            <Workbench>
              <button>Create project</button>
            </Workbench>
          </ApplicationReadinessRoot>,
        );
      });
      await expect(readiness.ready).resolves.toBeUndefined();
      expect(success).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Create project" })).toBeTruthy();
    });

    test("waits through nested lazy commits and StrictMode replay without resetting committed state", async () => {
      const outer = deferredSurface();
      const inner = deferredSurface();
      const { readiness, success, failure } = observeReadiness();
      render(
        <StrictMode>
          <ApplicationReadinessRoot readiness={readiness}>
            <Workbench>
              <Counter />
              <ApplicationSurface fallback={<span role="status">Opening route</span>}>
                <outer.View />
              </ApplicationSurface>
            </Workbench>
          </ApplicationReadinessRoot>
        </StrictMode>,
      );
      await act(async () => {
        screen.getByRole("button", { name: "Count 0" }).click();
      });
      expect(success).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();

      await act(async () => {
        outer.resolve({
          default: () => (
            <ApplicationSurface fallback={<span role="status">Opening editor</span>}>
              <inner.View />
            </ApplicationSurface>
          ),
        });
      });
      expect(screen.getByRole("status").textContent).toBe("Opening editor");
      expect(success).not.toHaveBeenCalled();

      await act(async () => {
        inner.resolve({ default: () => <button>Edit page</button> });
      });
      await expect(readiness.ready).resolves.toBeUndefined();
      expect(screen.getByRole("button", { name: "Edit page" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
      expect(success).toHaveBeenCalledOnce();
      expect(failure).not.toHaveBeenCalled();
    });

    test.each([true, false])(
      "retains a lazy surface while waiting for its initial content only when active=%s",
      async (active) => {
        const surface = deferredSurface();
        const { readiness, success, failure } = observeReadiness();
        const content = (isActive: boolean) => (
          <ApplicationReadinessRoot readiness={readiness}>
            <Workbench>
              <ApplicationSurface active={isActive}>
                <surface.View />
              </ApplicationSurface>
            </Workbench>
          </ApplicationReadinessRoot>
        );
        const view = render(content(active));
        await act(async () => Promise.resolve());
        expect(surface.load).toHaveBeenCalledOnce();
        if (active) expect(success).not.toHaveBeenCalled();
        else expect(success).toHaveBeenCalledOnce();

        await act(async () => surface.resolve({ default: Counter }));
        await expect(readiness.ready).resolves.toBeUndefined();
        await act(async () => screen.getByRole("button", { name: "Count 0" }).click());
        await act(async () => view.rerender(content(!active)));
        expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
        expect(surface.load).toHaveBeenCalledOnce();
        expect(success).toHaveBeenCalledOnce();
        expect(failure).not.toHaveBeenCalled();
      },
    );

    test("contains a hidden lazy failure while visible content is still opening", async () => {
      const hidden = deferredSurface();
      const visible = deferredSurface();
      const { readiness, success, failure } = observeReadiness();
      const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      render(
        <ApplicationReadinessRoot readiness={readiness}>
          <Workbench>
            <ApplicationSurface active={false}>
              <hidden.View />
            </ApplicationSurface>
            <ApplicationSurface>
              <visible.View />
            </ApplicationSurface>
          </Workbench>
        </ApplicationReadinessRoot>,
      );
      await act(async () => hidden.reject(new Error("hidden surface import failed")));
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Restart Nodex" })).toBeTruthy();
      expect(success).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();

      await act(async () => visible.resolve({ default: () => <button>Edit page</button> }));
      await expect(readiness.ready).resolves.toBeUndefined();
      expect(screen.getByRole("button", { name: "Edit page" })).toBeTruthy();
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(success).toHaveBeenCalledOnce();
      expect(failure).not.toHaveBeenCalled();
      expect(
        loggedErrors.mock.calls
          .flat()
          .some((entry) => String(entry).includes("not wrapped in act")),
      ).toBe(false);
    });

    test("rejects a failed initial lazy import while retaining an operable restart action", async () => {
      const route = deferredSurface();
      const error = new Error("route import failed");
      const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const restartApplication = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window, "api", { configurable: true, value: { restartApplication } });
      const { readiness, success, failure } = observeReadiness();
      render(
        <ApplicationReadinessRoot readiness={readiness}>
          <Workbench>
            <ApplicationSurface>
              <route.View />
            </ApplicationSurface>
          </Workbench>
        </ApplicationReadinessRoot>,
      );
      await act(async () => route.reject(error));
      await expect(readiness.ready).rejects.toBe(error);
      expect(success).not.toHaveBeenCalled();
      expect(failure).toHaveBeenCalledWith(error);
      expect(screen.getByRole("alert")).toBeTruthy();
      await act(async () => screen.getByRole("button", { name: "Restart Nodex" }).click());
      expect(restartApplication).toHaveBeenCalledOnce();
      expect(
        loggedErrors.mock.calls
          .flat()
          .some((entry) => String(entry).includes("not wrapped in act")),
      ).toBe(false);
    });

    test("contains later route failures without revisiting readiness or unmounting the Workbench", async () => {
      const route = deferredSurface();
      const { readiness, success, failure } = observeReadiness();
      const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      function Routes() {
        const [opened, setOpened] = useState(false);
        return (
          <Workbench>
            <Counter />
            <button onClick={() => setOpened(true)}>Open route</button>
            {opened ? (
              <ApplicationSurface fallback={<span role="status">Opening</span>}>
                <route.View />
              </ApplicationSurface>
            ) : null}
          </Workbench>
        );
      }
      render(
        <ApplicationReadinessRoot readiness={readiness}>
          <Routes />
        </ApplicationReadinessRoot>,
      );
      await act(async () => Promise.resolve());
      await expect(readiness.ready).resolves.toBeUndefined();
      await act(async () => {
        screen.getByRole("button", { name: "Count 0" }).click();
        screen.getByRole("button", { name: "Open route" }).click();
      });
      expect(screen.getByRole("status")).toBeTruthy();
      await act(async () => route.reject(new Error("later import failed")));
      expect(screen.getByRole("button", { name: "Count 1" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Restart Nodex" })).toBeTruthy();
      expect(success).toHaveBeenCalledOnce();
      expect(failure).not.toHaveBeenCalled();
      expect(
        loggedErrors.mock.calls
          .flat()
          .some((entry) => String(entry).includes("not wrapped in act")),
      ).toBe(false);
    });

    test("rejects an unmounted pending root and does not retain work across another mount", async () => {
      const route = deferredSurface();
      const { readiness, success } = observeReadiness();
      const view = render(
        <StrictMode>
          <ApplicationReadinessRoot readiness={readiness}>
            <Workbench>
              <ApplicationSurface>
                <route.View />
              </ApplicationSurface>
            </Workbench>
          </ApplicationReadinessRoot>
        </StrictMode>,
      );
      await act(async () => view.unmount());
      await expect(readiness.ready).rejects.toThrow("unmounted before opening");
      await act(async () => route.resolve({ default: () => <button>Obsolete route</button> }));
      expect(success).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Obsolete route" })).toBeNull();

      const next = observeReadiness();
      render(
        <ApplicationReadinessRoot readiness={next.readiness}>
          <Workbench>
            <button>Welcome</button>
          </Workbench>
        </ApplicationReadinessRoot>,
      );
      await act(async () => Promise.resolve());
      await expect(next.readiness.ready).resolves.toBeUndefined();
    });

    test("also recovers errors outside a local Suspense boundary", async () => {
      const error = new Error("root render failed");
      const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { readiness } = observeReadiness();
      function BrokenWorkbench(): ReactNode {
        throw error;
      }
      render(
        <ApplicationReadinessRoot readiness={readiness}>
          <BrokenWorkbench />
        </ApplicationReadinessRoot>,
      );
      await act(async () => Promise.resolve());
      await expect(readiness.ready).rejects.toBe(error);
      expect(screen.getByRole("button", { name: "Restart Nodex" })).toBeTruthy();
      expect(
        loggedErrors.mock.calls
          .flat()
          .some((entry) => String(entry).includes("not wrapped in act")),
      ).toBe(false);
    });
  });
});

describe("auxiliary window appearance", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("class");
    document.documentElement.removeAttribute("data-theme");
    document.body.removeAttribute("style");
  });

  test("restricted windows restore and follow shared typography without the application preload", async () => {
    const apiDescriptor = Object.getOwnPropertyDescriptor(window, "api");
    Object.defineProperty(window, "api", { configurable: true, value: undefined });
    try {
      writeThemePreference("light");
      const preferences = readTypographyPreferences();
      writeTypographyPreferences({
        ...preferences,
        useFontSmoothing: false,
        fonts: {
          ...preferences.fonts,
          dark: { ...preferences.fonts.dark, content: "Georgia" },
        },
      });
      render(
        <StrictMode>
          <AuxiliaryWindowAppearance>
            <span>Overlay content</span>
          </AuxiliaryWindowAppearance>
        </StrictMode>,
      );
      for (const element of [document.documentElement, document.body]) {
        expect(element.style.getPropertyValue("--font-smoothing")).toBe("auto");
      }

      await actForAuxiliaryWindowAppearance(async () => {
        writeTypographyPreferences({ ...readTypographyPreferences(), useFontSmoothing: true });
        writeThemePreference("dark");
        for (const key of [TYPOGRAPHY_STORAGE_KEY, THEME_STORAGE_KEY]) {
          window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
        }
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(document.documentElement.dataset.theme).toBe("dark");
        for (const element of [document.documentElement, document.body]) {
          expect(element.style.getPropertyValue("--font-smoothing")).toBe("antialiased");
          expect(element.style.getPropertyValue("--font-content")).toContain("Georgia");
        }
      });
    } finally {
      cleanup();
      if (apiDescriptor) Object.defineProperty(window, "api", apiDescriptor);
      else Reflect.deleteProperty(window, "api");
    }
  });
});

describe("renderer document", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    document.documentElement.removeAttribute("class");
  });

  afterEach(() => {
    installWindowApi(undefined);
    initializeRendererDocument();
    document.documentElement.removeAttribute("class");
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.codexWindowType;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  describe("renderer document runtime", () => {
    test("releases Electron ownership when initialized without a preload bridge", () => {
      const unsubscribe = vi.fn();
      installWindowApi({ on: () => unsubscribe });
      initializeRendererDocument();
      document.documentElement.classList.add("electron-opaque");

      installWindowApi(undefined);
      initializeRendererDocument();

      const root = document.documentElement;
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(root.dataset.codexWindowType).toBe("browser");
      expect(root.dataset.windowType).toBeUndefined();
      expect(root.dataset.codexOs).toBeUndefined();
      expect(root.dataset.codexWindowChrome).toBeUndefined();
      expect(root.classList.contains("electron-opaque")).toBe(false);
    });

    test("preserves parser appearance and follows the live Electron surface capability", () => {
      let surfaceListener: ((payload: unknown) => void) | undefined;
      const unsubscribe = vi.fn();
      const on = vi.fn((event: string, listener: (payload: unknown) => void) => {
        surfaceListener = listener;
        return unsubscribe;
      });
      installWindowApi({ on });
      vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
      const root = document.documentElement;
      root.classList.add("dark", "electron-opaque");

      initializeRendererDocument();

      expect(root.dataset.codexWindowType).toBe("electron");
      expect(root.dataset.codexOs).toBe("win32");
      expect(root.dataset.codexWindowChrome).toBe("application-menu");
      expect(root.classList.contains("electron-dark")).toBe(true);
      expect(root.classList.contains("electron-opaque")).toBe(true);
      expect(on).toHaveBeenCalledWith(
        "electron-window-opaque-surface-changed",
        expect.any(Function),
      );

      surfaceListener?.({ opaqueWindowSurfaceEnabled: false });
      expect(root.classList.contains("electron-opaque")).toBe(false);
      surfaceListener?.({ opaqueWindowSurfaceEnabled: true });
      expect(root.classList.contains("electron-opaque")).toBe(true);

      initializeRendererDocument();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    test("keeps compact Electron windows transparent when opaque surfaces are enabled", () => {
      let surfaceListener: ((payload: unknown) => void) | undefined;
      installWindowApi({
        on: (_event: string, listener: (payload: unknown) => void) => {
          surfaceListener = listener;
          return () => undefined;
        },
      });
      window.history.replaceState(null, "", "/?initialRoute=%2Fglobal-dictation");
      const root = document.documentElement;
      root.classList.add("electron-opaque");

      initializeRendererDocument();
      surfaceListener?.({ opaqueWindowSurfaceEnabled: true });

      expect(root.classList.contains("compact-window")).toBe(true);
      expect(root.classList.contains("hide-startup-shell")).toBe(true);
      expect(root.classList.contains("electron-opaque")).toBe(false);
    });
  });
});

describe("theme bootstrap", () => {
  const bootstrap = readFileSync(resolve("src/renderer/public/theme-bootstrap.js"), "utf8");

  describe("parser-time theme selection", () => {
    test.each([
      { preference: "light", systemDark: true, resolved: "light" },
      { preference: "dark", systemDark: false, resolved: "dark" },
      { preference: "system", systemDark: true, resolved: "dark" },
      { preference: null, systemDark: false, resolved: "light" },
    ])(
      "selects the CSS scheme before renderer initialization: $preference / $systemDark",
      ({ preference, systemDark, resolved }) => {
        const root = document.createElement("html");
        runInNewContext(bootstrap, {
          document: { documentElement: root },
          localStorage: { getItem: () => preference },
          navigator: { platform: "MacIntel" },
          URL,
          URLSearchParams,
          window: {
            location: { href: "http://localhost/", search: "" },
            matchMedia: () => ({ matches: systemDark }),
          },
        });

        expect(root.dataset.theme).toBe(resolved);
        expect(root.classList.contains("dark")).toBe(resolved === "dark");
        expect(root.classList.contains(`electron-${resolved}`)).toBe(true);
      },
    );
  });
});
