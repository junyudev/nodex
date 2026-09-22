import { describe, expect, it, vi } from "vitest";
import { ClipboardSafePasteError, ClipboardSafePasteService } from "./clipboard-safe-paste-service";
import type { DictationNativePasteResult } from "./dictation-native-helper-port";

const target = { pid: 42, bundleIdentifier: "example.app" };
const deferredPaste = () => {
  let resolve!: (value: DictationNativePasteResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DictationNativePasteResult>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
};
const createService = () => {
  const helper = {
    captureClipboardFingerprint: vi.fn(async () => "a".repeat(64)),
    copy: vi.fn(async (_text: string) => {}),
    safePaste: vi.fn(async (): Promise<DictationNativePasteResult> => ({
      clipboardRestoreMs: 710,
    })),
  };
  return { helper, service: new ClipboardSafePasteService({ helper }) };
};

describe("ClipboardSafePasteService", () => {
  it("delegates one native transaction with normalized trailing space and stop evidence", async () => {
    const { service, helper } = createService();
    const options = {
      clipboardFingerprint: "a".repeat(64),
      recordingStoppedAtMs: 1234,
      signal: new AbortController().signal,
    };

    await expect(service.paste("  hello  ", target, options)).resolves.toEqual({
      clipboardRestoreMs: 710,
    });
    expect(helper.safePaste).toHaveBeenCalledWith("hello ", target, options);
  });

  it("captures stop-time fingerprints and copies through the native authority", async () => {
    const { service, helper } = createService();
    await expect(service.captureClipboardFingerprint()).resolves.toBe("a".repeat(64));
    await service.copy("hello");
    expect(helper.copy).toHaveBeenCalledWith("hello");
  });

  it("pastes through the focused application without requiring target metadata", async () => {
    const { service, helper } = createService();
    await expect(service.paste("hello")).resolves.toEqual({ clipboardRestoreMs: 710 });
    expect(helper.safePaste).toHaveBeenCalledWith("hello ", undefined, {});
  });

  it.each([
    { reason: "accessibility", copied: true },
    { reason: "clipboard-changed", copied: false },
    { reason: "paste", copied: true },
  ] as const)("preserves $reason recovery evidence", async (failure) => {
    const { service, helper } = createService();
    const result = { clipboardRestoreMs: 0, failure: { ...failure, text: "hello " } };
    helper.safePaste.mockResolvedValue(result);
    await expect(service.paste("hello", target)).resolves.toEqual(result);
    expect(helper.safePaste).toHaveBeenCalledOnce();
  });

  it("maps transport failure to a retryable paste error", async () => {
    const { service, helper } = createService();
    helper.safePaste.mockRejectedValue(new Error("helper exited"));
    await expect(service.paste("hello", target)).rejects.toBeInstanceOf(ClipboardSafePasteError);
  });

  it("keeps cancellation distinct from paste failure", async () => {
    const { service, helper } = createService();
    const abort = new DOMException("Cancelled", "AbortError");
    helper.safePaste.mockRejectedValue(abort);
    await expect(service.paste("hello", target)).rejects.toBe(abort);
  });

  it("holds a replacement paste until cancelled native cleanup acknowledges its grace", async () => {
    const { service, helper } = createService();
    const cleanup = deferredPaste();
    helper.safePaste.mockReturnValueOnce(cleanup.promise);
    const abort = new AbortController();
    const first = service.paste("first", target, { signal: abort.signal });
    const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(helper.safePaste).toHaveBeenCalledOnce());
    abort.abort();
    const second = service.paste("second", target);
    await Promise.resolve();
    expect(helper.safePaste).toHaveBeenCalledOnce();
    cleanup.reject(new DOMException("Cancelled", "AbortError"));
    await rejection;
    await expect(second).resolves.toEqual({ clipboardRestoreMs: 710 });
    expect(helper.safePaste).toHaveBeenLastCalledWith("second ", target, {});
  });

  it("serializes recovery copy and skips a queued session cancelled before native dispatch", async () => {
    const { service, helper } = createService();
    const cleanup = deferredPaste();
    helper.safePaste.mockReturnValueOnce(cleanup.promise);
    const first = service.paste("first", target);
    const abort = new AbortController();
    const second = service.paste("second", target, { signal: abort.signal });
    const rejection = expect(second).rejects.toMatchObject({ name: "AbortError" });
    const copied = service.copy("manual");
    abort.abort();
    await vi.waitFor(() => expect(helper.safePaste).toHaveBeenCalledOnce());
    expect(helper.copy).not.toHaveBeenCalled();
    cleanup.resolve({ clipboardRestoreMs: 710 });
    await first;
    await rejection;
    await copied;
    expect(helper.safePaste).toHaveBeenCalledOnce();
    expect(helper.copy).toHaveBeenCalledWith("manual");
  });

  it("rejects blank text and pre-aborted sessions without native mutation", async () => {
    const { service, helper } = createService();
    await expect(service.paste("  ", target)).rejects.toBeInstanceOf(ClipboardSafePasteError);
    await expect(
      service.paste("hello", target, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(helper.safePaste).not.toHaveBeenCalled();
  });
});
