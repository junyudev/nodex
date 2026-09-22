/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- Adapts the native addon callback and disposable to the caller-owned AbortSignal boundary. */
import { compileMacNativeHotkey, normalizeAccelerator } from "../../../shared/command-keybindings";
import type { BrowserRuntimeAvailability } from "../../codex/browser-runtime-bundle";
import { loadSkyNativeAddon } from "../../sky-native";

/** The admitted bundle's local-window monitor does not require a global input tap. */
export async function captureMacBareModifier(input: {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly nativeWindowHandle: Buffer;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  const { browserRuntime, nativeWindowHandle, signal } = input;
  signal?.throwIfAborted();
  if (browserRuntime.status !== "available" || nativeWindowHandle.length === 0) return null;
  const { bundle } = browserRuntime;
  const exports = bundle.manifest.capabilities.nativePip.exports.expectedExports;
  if (!exports.includes("startModifierCapture")) return null;
  const addon = loadSkyNativeAddon(bundle.paths.skyNativeAddon, exports);
  if (typeof addon?.startModifierCapture !== "function") return null;

  return await new Promise<string | null>((resolve, reject) => {
    let session: { dispose(): void } | null = null;
    let settled = false;
    const dispose = (): void => {
      const active = session;
      session = null;
      active?.dispose();
    };
    const finish = (value: string | null, error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      try {
        dispose();
      } catch (disposeError) {
        reject(disposeError);
        return;
      }
      if (error) reject(error);
      else resolve(value);
    };
    const abort = (): void =>
      finish(null, new DOMException("Hotkey capture cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      session = addon.startModifierCapture!(nativeWindowHandle, (value) => {
        if (settled || typeof value !== "string") return;
        const accelerator = normalizeAccelerator(value);
        const compiled = compileMacNativeHotkey({
          accelerator,
          bindingId: "capture",
          mode: "hold",
        });
        if (compiled.type !== "compiled" || compiled.spec.keyCode !== null) return;
        // Leave the native callback's stack before releasing its captured function reference.
        queueMicrotask(() => finish(accelerator));
      });
      if (settled) dispose();
      else if (!session) finish(null);
    } catch {
      finish(null);
    }
  });
}
