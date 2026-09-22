/* oxlint-disable effecttsgo/async-function -- Exercises native callback and AbortSignal completion at the platform boundary. */
import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserRuntimeAvailability } from "../../codex/browser-runtime-bundle";
import { loadSkyNativeAddon, type SkyNativeAddon } from "../../sky-native";
import { captureMacBareModifier } from "./MacBareModifierCapture";

vi.mock("../../sky-native", () => ({ loadSkyNativeAddon: vi.fn() }));

const runtime = (exports = ["startModifierCapture"]): BrowserRuntimeAvailability =>
  ({
    status: "available",
    bundle: {
      paths: { skyNativeAddon: "/verified/browser-runtime/native/sky.node" },
      manifest: { capabilities: { nativePip: { exports: { expectedExports: exports } } } },
    },
  }) as BrowserRuntimeAvailability;

const handle = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
const mockAddon = (startModifierCapture: NonNullable<SkyNativeAddon["startModifierCapture"]>) => {
  vi.mocked(loadSkyNativeAddon).mockReturnValue({ startModifierCapture } as SkyNativeAddon);
};

beforeEach(() => vi.resetAllMocks());

it("loads only the admitted path/export inventory and disposes after a valid bare gesture", async () => {
  let emit!: (accelerator: string) => void;
  const dispose = vi.fn();
  const start = vi.fn((window: Buffer, callback: typeof emit) => {
    expect(window).toBe(handle);
    emit = callback;
    return { dispose };
  });
  mockAddon(start);
  const result = captureMacBareModifier({ browserRuntime: runtime(), nativeWindowHandle: handle });
  expect(loadSkyNativeAddon).toHaveBeenCalledWith("/verified/browser-runtime/native/sky.node", [
    "startModifierCapture",
  ]);
  emit("Control+K");
  emit("RightControl");
  expect(dispose).not.toHaveBeenCalled();
  emit("Ctrl+Alt+Fn");
  await expect(result).resolves.toBe("Ctrl+Alt+Fn");
  expect(dispose).toHaveBeenCalledOnce();
  emit("Fn");
  expect(dispose).toHaveBeenCalledOnce();
});

it("disposes immediately on abort and excludes callbacks queued before or after cancellation", async () => {
  const controller = new AbortController();
  let emit!: (accelerator: string) => void;
  const dispose = vi.fn();
  mockAddon((_window, callback) => {
    emit = callback;
    return { dispose };
  });
  const result = captureMacBareModifier({
    browserRuntime: runtime(),
    nativeWindowHandle: handle,
    signal: controller.signal,
  });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  emit("Fn");
  controller.abort();
  expect(dispose).toHaveBeenCalledOnce();
  emit("DoubleOption");
  await rejected;
  expect(dispose).toHaveBeenCalledOnce();
});

it("handles synchronous capture and abort during registration without leaking its returned session", async () => {
  const dispose = vi.fn();
  mockAddon((_window, emit) => {
    emit("DoubleShift");
    return { dispose };
  });
  await expect(
    captureMacBareModifier({ browserRuntime: runtime(), nativeWindowHandle: handle }),
  ).resolves.toBe("DoubleShift");
  expect(dispose).toHaveBeenCalledOnce();
  const controller = new AbortController();
  const abortedDispose = vi.fn();
  mockAddon(() => {
    controller.abort();
    return { dispose: abortedDispose };
  });
  await expect(
    captureMacBareModifier({
      browserRuntime: runtime(),
      nativeWindowHandle: handle,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(abortedDispose).toHaveBeenCalledOnce();
});

it("fails closed without loading an ambient addon or invoking a native global fallback", async () => {
  await expect(
    captureMacBareModifier({
      browserRuntime: { status: "unavailable", reason: "manifest-missing", message: "Unavailable" },
      nativeWindowHandle: handle,
    }),
  ).resolves.toBeNull();
  await expect(
    captureMacBareModifier({ browserRuntime: runtime([]), nativeWindowHandle: handle }),
  ).resolves.toBeNull();
  const controller = new AbortController();
  controller.abort();
  await expect(
    captureMacBareModifier({
      browserRuntime: runtime(),
      nativeWindowHandle: handle,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(loadSkyNativeAddon).not.toHaveBeenCalled();
  vi.mocked(loadSkyNativeAddon).mockReturnValue(null);
  await expect(
    captureMacBareModifier({ browserRuntime: runtime(), nativeWindowHandle: handle }),
  ).resolves.toBeNull();
  mockAddon(() => null);
  await expect(
    captureMacBareModifier({ browserRuntime: runtime(), nativeWindowHandle: handle }),
  ).resolves.toBeNull();
});
