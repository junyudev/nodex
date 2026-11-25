import { describe, expect, vi, afterEach, test } from "vite-plus/test";
import { it } from "vitest";
import { ClipboardSafePasteError, ClipboardSafePasteService } from "./clipboard-safe-paste-service";
import type { DictationNativePasteResult } from "./dictation-native-helper-port";
import { mkdtemp, rm, writeFile, mkdir, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DictationSettingsStore } from "./dictation-settings-store";
import { DICTATION_HISTORY_MAX_AUDIO_BYTES } from "../../shared/dictation-history";
import { readDictationWebmFile, validateDictationWebm } from "./dictation-file-import";
import { DictationRequestDiagnostics } from "./dictation-request-diagnostics";

describe("clipboard-safe-paste-service", () => {
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
});

describe("dictation-settings-store", () => {
  const temporaryDirectories: string[] = [];

  const createStore = async (): Promise<{ directory: string; store: DictationSettingsStore }> => {
    const directory = await mkdtemp(join(tmpdir(), "nodex-dictation-settings-"));
    temporaryDirectories.push(directory);
    return { directory, store: new DictationSettingsStore(directory) };
  };

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  describe("DictationSettingsStore", () => {
    test("persists strict typed patches and rejects unknown settings", async () => {
      const { store } = await createStore();
      expect(await store.read()).toMatchObject({
        microphoneInputDeviceId: null,
        dictationSoundsEnabled: true,
        globalShortcutNudgeDismissed: false,
        dictionary: [],
      });

      await expect(store.update({ microphoneInputDeviceId: "mic-1" })).resolves.toMatchObject({
        microphoneInputDeviceId: "mic-1",
      });
      await expect(store.update({ dictationSoundsEnabled: false })).resolves.toMatchObject({
        dictationSoundsEnabled: false,
      });
      expect(() => store.update({ microphoneInputDeviceId: "" })).toThrow();
      expect(() => store.update({ dictationSoundsEnabled: "yes" })).toThrow();
      expect(() => store.update({ unknown: true })).toThrow("Unknown dictation setting");
      expect((await store.read()).microphoneInputDeviceId).toBe("mic-1");
    });

    test("persists a bounded dictation dictionary and migrates older settings to an empty list", async () => {
      const { directory, store } = await createStore();
      await expect(
        store.update({ dictionary: ["  Nodex  ", "useCartState"] }),
      ).resolves.toMatchObject({
        dictionary: ["  Nodex  ", "useCartState"],
      });
      expect(() =>
        store.update({ dictionary: Array.from({ length: 101 }, () => "entry") }),
      ).toThrow("dictionary");

      await writeFile(
        join(directory, "dictation-settings.json"),
        JSON.stringify({
          microphoneInputDeviceId: null,
          globalShortcutNudgeDismissed: false,
        }),
        { mode: 0o600 },
      );

      expect((await store.read()).dictionary).toEqual([]);
    });

    test("lets exactly one concurrent renderer claim the global shortcut nudge", async () => {
      const { store } = await createStore();
      const claims = await Promise.all([
        store.consumeGlobalShortcutNudge(),
        store.consumeGlobalShortcutNudge(),
        store.consumeGlobalShortcutNudge(),
      ]);

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await store.read()).globalShortcutNudgeDismissed).toBe(true);
    });

    test("reads settings written before the nudge flag existed", async () => {
      const { directory, store } = await createStore();
      await writeFile(
        join(directory, "dictation-settings.json"),
        JSON.stringify({
          microphoneInputDeviceId: null,
        }),
        { mode: 0o600 },
      );

      expect((await store.read()).globalShortcutNudgeDismissed).toBe(false);
    });
  });
});

describe("dictation-file-import", () => {
  const roots: string[] = [];
  const webm = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x18, 0x53, 0x80, 0x67,
    0xff, 0xe7, 0x81, 0,
  ]);

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function selectedFile(name: string, bytes = webm) {
    const root = await mkdtemp(join(tmpdir(), "nodex-dictation-file-"));
    roots.push(root);
    const filePath = join(root, name);
    await writeFile(filePath, bytes);
    return filePath;
  }

  describe("WebM file import", () => {
    test("reads the exact bytes and basename of a native selection", async () => {
      const selected = await readDictationWebmFile(await selectedFile("Interview.WEBM"));
      expect(selected).toEqual({ fileName: "Interview.WEBM", bytes: webm });
      expect(Object.keys(selected)).toEqual(["fileName", "bytes"]);
    });

    test("accepts finite and unknown Segment lengths", () => {
      expect(() => validateDictationWebm(webm)).not.toThrow();
      const finite = Uint8Array.from(webm);
      finite[16] = 0x83;
      expect(() => validateDictationWebm(finite)).not.toThrow();
    });

    test("rejects other containers, truncated elements, duplicate DocTypes and missing audio bytes", () => {
      const otherDocType = Uint8Array.from(webm);
      otherDocType[11] = 0x76;
      const oversizedSegment = Uint8Array.from(webm);
      oversizedSegment[16] = 0x84;
      const duplicateDocType = new Uint8Array([
        ...webm.subarray(0, 4),
        0x8e,
        ...webm.subarray(5, 12),
        ...webm.subarray(5, 12),
        ...webm.subarray(12),
      ]);
      for (const malformed of [
        new Uint8Array([1, 2, 3]),
        otherDocType,
        webm.subarray(0, 10),
        webm.subarray(0, 17),
        oversizedSegment,
        duplicateDocType,
      ]) {
        expect(() => validateDictationWebm(malformed)).toThrow();
      }
    });

    test("rejects empty, mislabeled, non-regular and oversized selections before reading audio", async () => {
      await expect(
        readDictationWebmFile(await selectedFile("empty.webm", new Uint8Array())),
      ).rejects.toThrow("empty");
      await expect(readDictationWebmFile(await selectedFile("audio.wav"))).rejects.toThrow("WebM");
      await expect(
        readDictationWebmFile(await selectedFile("fake.webm", new Uint8Array([1, 2, 3]))),
      ).rejects.toThrow();
      const oversized = await selectedFile("oversized.webm");
      await truncate(oversized, DICTATION_HISTORY_MAX_AUDIO_BYTES + 1);
      await expect(readDictationWebmFile(oversized)).rejects.toThrow("64 MiB");
      const directory = join(roots[0]!, "directory.webm");
      await mkdir(directory);
      await expect(readDictationWebmFile(directory)).rejects.toThrow("regular");
    });

    test("honors cancellation before opening the file", async () => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(
        readDictationWebmFile(await selectedFile("cancelled.webm"), controller.signal),
      ).rejects.toThrow("cancelled");
    });
  });
});

describe("dictation-request-diagnostics", () => {
  it("separates response-header wait from body consumption and selects only safe request headers", () => {
    let now = 10;
    const diagnostics = new DictationRequestDiagnostics(
      "cleanup",
      "4ee71509-91df-4ebe-adef-9cc41b200af1",
      () => now,
    );
    diagnostics.sentHeaders(
      new Headers({
        authorization: "Bearer secret-token",
        "chatgpt-account-id": "private-account",
        originator: "Codex Desktop",
        "user-agent": "Codex Desktop/test",
        cookie: "private-cookie",
      }),
    );
    now = 110;
    diagnostics.response(new Response(null, { headers: { "x-request-id": "req_123" } }));
    now = 160;
    expect(diagnostics.finish("completed")).toEqual({
      operation: "cleanup",
      requestId: "4ee71509-91df-4ebe-adef-9cc41b200af1",
      endpoint: "/codex/responses",
      model: "gpt-5.6-luna",
      outcome: "completed",
      totalMs: 150,
      headersMs: 100,
      bodyMs: 50,
      status: 200,
      attempts: 1,
      responseId: "req_123",
      headers: {
        originator: "Codex Desktop",
        userAgent: "Codex Desktop/test",
        authorizationPresent: true,
        accountHeaderPresent: true,
      },
    });
  });

  it("retains failed request elapsed time without inventing an HTTP status", () => {
    let now = 0;
    const diagnostics = new DictationRequestDiagnostics(
      "transcription",
      "4ee71509-91df-4ebe-adef-9cc41b200af1",
      () => now,
    );
    now = 250;
    expect(diagnostics.finish("failed")).toMatchObject({
      outcome: "failed",
      totalMs: 250,
      attempts: 0,
    });
    expect(diagnostics.finish("failed").status).toBeUndefined();
  });
});
