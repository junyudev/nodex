import { act, lazy, type ComponentType, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../shared/workbench-layout";
import { FAIL_CLOSED_RUNTIME_CAPABILITIES } from "../shared/runtime-capabilities";
import { ApplicationSurface, useApplicationReady } from "./bootstrap/application-surface";
import { mountApplicationRenderer } from "./application-renderer";

const harness = vi.hoisted(() => ({
  root: null as Root | null,
  content: null as ReactNode,
}));

vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      harness.root = original.createRoot(...args);
      return harness.root;
    },
  };
});
vi.mock("./bootstrap/application-appearance", () => ({
  initializeApplicationAppearance: vi.fn(),
}));
vi.mock("./app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./app", () => ({
  default: () => harness.content,
}));

function ReadyWorkbench({ children }: { readonly children: ReactNode }) {
  useApplicationReady(true);
  return children;
}

function mount() {
  return mountApplicationRenderer({
    runtimeCapabilities: FAIL_CLOSED_RUNTIME_CAPABILITIES,
    windowSessionBootstrap: {
      session: {
        id: "window-a",
        lifecycle: { state: "open" },
        layoutRevision: 0,
        layout: createDefaultWorkbenchLayoutSnapshot(),
        createdAt: "2026-10-16T00:00:00Z",
        updatedAt: "2026-10-16T00:00:00Z",
        focusedAt: "2026-10-16T00:00:00Z",
      },
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"><span>Startup shell</span></div>';
});

afterEach(async () => {
  await act(async () => harness.root?.unmount());
  harness.root = null;
  harness.content = null;
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "api");
  document.body.innerHTML = "";
});

describe("application renderer mount", () => {
  test("resolves only after its initial lazy surface commits", async () => {
    let resolve = (_module: { default: ComponentType }): void => undefined;
    const module = new Promise<{ default: ComponentType }>((accept) => {
      resolve = accept;
    });
    const Route = lazy(() => module);
    harness.content = (
      <ReadyWorkbench>
        <ApplicationSurface fallback={<span role="status">Opening</span>}>
          <Route />
        </ApplicationSurface>
      </ReadyWorkbench>
    );
    const mounted = vi.fn();
    let result: Promise<void> | undefined;
    await act(async () => {
      result = mount();
      void result.then(mounted);
    });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(mounted).not.toHaveBeenCalled();
    await act(async () => resolve({ default: () => <button>Ready route</button> }));
    await expect(result).resolves.toBeUndefined();
    expect(screen.getByRole("button", { name: "Ready route" })).toBeTruthy();
    expect(mounted).toHaveBeenCalledOnce();
  });

  test("rejects failed lazy mounting with recovery attached to the current React root", async () => {
    let reject = (_error: unknown): void => undefined;
    const module = new Promise<{ default: ComponentType }>((_accept, fail) => {
      reject = fail;
    });
    const Route = lazy(() => module);
    const error = new Error("initial route failed");
    const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const restartApplication = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "api", { configurable: true, value: { restartApplication } });
    harness.content = (
      <ReadyWorkbench>
        <ApplicationSurface>
          <Route />
        </ApplicationSurface>
      </ReadyWorkbench>
    );
    let result: Promise<void> | undefined;
    await act(async () => {
      result = mount();
      void result.catch(() => undefined);
    });
    await act(async () => reject(error));
    await expect(result).rejects.toBe(error);
    const restart = screen.getByRole("button", { name: "Restart Nodex" });
    expect(document.getElementById("root")?.contains(restart)).toBe(true);
    await act(async () => restart.click());
    expect(restartApplication).toHaveBeenCalledOnce();
    expect(
      loggedErrors.mock.calls.flat().some((entry) => String(entry).includes("not wrapped in act")),
    ).toBe(false);
  });
});
