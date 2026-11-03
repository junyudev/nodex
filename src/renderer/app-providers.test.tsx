import { useLayoutEffect } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { TestQueryProvider } from "@/test/query";
import { useMaitaiStore, type MaitaiStore } from "./lib/maitai";
import type { AppUpdateStatus } from "./lib/types";
import {
  AppUpdateStatusProvider,
  RendererStateProvider,
  useAppUpdateStatus,
} from "./app-providers";
import {
  ReducedMotionProvider,
  useReducedMotionPreference,
  useResolvedReducedMotion,
} from "./lib/use-reduced-motion";
import { REDUCED_MOTION_STORAGE_KEY } from "./lib/reduced-motion";

const updateMocks = vi.hoisted(() => ({
  listener: null as ((status: AppUpdateStatus) => void) | null,
  resolveSnapshot: null as ((status: AppUpdateStatus) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  invoke: vi.fn(
    () =>
      new Promise<AppUpdateStatus>((resolve) => {
        updateMocks.resolveSnapshot = resolve;
      }),
  ),
  subscribeAppUpdateStatus: vi.fn((listener: (status: AppUpdateStatus) => void) => {
    updateMocks.listener = listener;
    return updateMocks.unsubscribe;
  }),
}));

const updateStatus = (status: AppUpdateStatus["status"], message: string): AppUpdateStatus => ({
  availableVersion: status === "downloaded" ? "0.2.2" : null,
  checkedAt: null,
  currentVersion: "0.2.1",
  message,
  progressPercent: null,
  releaseDate: null,
  releaseName: null,
  releaseNotes: null,
  status,
  supported: true,
  totalBytes: null,
  transferredBytes: null,
  channel: "stable",
  buildDefaultChannel: "stable",
  channelChangeAllowed: status === "idle" || status === "upToDate" || status === "error",
});

beforeEach(() => {
  updateMocks.listener = null;
  updateMocks.resolveSnapshot = null;
  updateMocks.unsubscribe.mockClear();
});

describe("renderer state provider", () => {
  test("keeps one Maitai store across parent rerenders", () => {
    const stores: MaitaiStore[] = [];
    function Probe({ value }: { value: string }) {
      const store = useMaitaiStore();
      useLayoutEffect(() => {
        stores.push(store);
      });
      return <span>{value}</span>;
    }
    const renderTree = (value: string) => (
      <TestQueryProvider>
        <RendererStateProvider>
          <Probe value={value} />
        </RendererStateProvider>
      </TestQueryProvider>
    );
    const view = render(renderTree("one"));
    view.rerender(renderTree("two"));

    expect(stores).toHaveLength(2);
    expect(stores[0]).toBe(stores[1]);
  });

  test("resolves and persists the app-scoped three-way motion preference", () => {
    const originalMatchMedia = window.matchMedia;
    window.localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, "system");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });

    function Probe() {
      const { preference, setPreference } = useReducedMotionPreference();
      const reduced = useResolvedReducedMotion();
      return (
        <div>
          <output>{`${preference}:${reduced ? "reduced" : "full"}`}</output>
          <button type="button" onClick={() => setPreference("on")}>
            On
          </button>
          <button type="button" onClick={() => setPreference("off")}>
            Off
          </button>
        </div>
      );
    }

    const view = render(
      <TestQueryProvider>
        <RendererStateProvider>
          <ReducedMotionProvider>
            <Probe />
          </ReducedMotionProvider>
        </RendererStateProvider>
      </TestQueryProvider>,
    );

    try {
      expect(view.getByText("system:reduced")).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Off" }));
      expect(view.getByText("off:full")).toBeTruthy();
      expect(window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY)).toBe("off");
      fireEvent.click(view.getByRole("button", { name: "On" }));
      expect(view.getByText("on:reduced")).toBeTruthy();
      expect(window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY)).toBe("on");
    } finally {
      view.unmount();
      window.localStorage.removeItem(REDUCED_MOTION_STORAGE_KEY);
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });
});

describe("app update status provider", () => {
  test("does not let a delayed initial snapshot replace a newer pushed status", async () => {
    function Probe() {
      return <span>{useAppUpdateStatus()?.message}</span>;
    }
    const view = render(
      <AppUpdateStatusProvider>
        <Probe />
      </AppUpdateStatusProvider>,
    );
    await waitFor(() => expect(updateMocks.listener).not.toBeNull());

    await act(async () => {
      updateMocks.listener?.(updateStatus("downloaded", "Update ready."));
      updateMocks.resolveSnapshot?.(updateStatus("checking", "Checking…"));
      await Promise.resolve();
    });

    expect(view.getByText("Update ready.")).toBeTruthy();
    view.unmount();
    expect(updateMocks.unsubscribe).toHaveBeenCalledOnce();
  });
});
