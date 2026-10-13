import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../test/browser-globals";
import { initializeRendererDocument } from "./renderer-document";

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
    expect(on).toHaveBeenCalledWith("electron-window-opaque-surface-changed", expect.any(Function));

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
