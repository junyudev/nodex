import { beforeEach, describe, expect, test, vi } from "vitest";
import { invokeRendererControl, invokeRendererQuery } from "@/lib/renderer-command";
import { captureGlobalDictationBareModifierHotkey } from "./dictation-settings-runtime";

vi.mock("@/lib/api", () => ({ subscribeCodexEvents: vi.fn() }));
vi.mock("@/lib/renderer-command", () => ({
  defineRendererCommand: vi.fn((value) => value),
  invokePlainCommand: vi.fn(),
  invokeRendererQuery: vi.fn(),
  invokeRendererControl: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invokeRendererControl).mockResolvedValue(true);
});

describe("native shortcut capture transport", () => {
  test("opens a suspension-only capture without accepting a native bare result", async () => {
    vi.mocked(invokeRendererQuery).mockResolvedValue("Fn");
    expect(
      await captureGlobalDictationBareModifierHotkey(new AbortController().signal, false),
    ).toBeNull();
    expect(invokeRendererQuery).toHaveBeenCalledExactlyOnceWith(
      "global-dictation-capture-bare-modifier-hotkey",
      false,
    );
  });
  test.each([
    "Fn",
    "Ctrl+Alt",
    "Shift+Fn",
    "Ctrl+Command+Alt+Shift+Fn",
    "DoubleCommand",
    "LeftControl",
  ])("accepts complete native bare gesture %s", async (accelerator) => {
    vi.mocked(invokeRendererQuery).mockResolvedValue(accelerator);
    expect(await captureGlobalDictationBareModifierHotkey(new AbortController().signal, true)).toBe(
      accelerator,
    );
    expect(invokeRendererQuery).toHaveBeenCalledExactlyOnceWith(
      "global-dictation-capture-bare-modifier-hotkey",
      true,
    );
  });

  test.each([null, "Ctrl", "RightControl", "Ctrl+K", "Fn+Q", "Fn+Fn"])(
    "rejects unsupported native result %s",
    async (accelerator) => {
      vi.mocked(invokeRendererQuery).mockResolvedValue(accelerator);
      expect(
        await captureGlobalDictationBareModifierHotkey(new AbortController().signal, true),
      ).toBeNull();
    },
  );

  test("cancels pending capture immediately and rejects a late result", async () => {
    let resolve!: (value: string | null) => void;
    const pending = new Promise<string | null>((done) => {
      resolve = done;
    });
    vi.mocked(invokeRendererQuery).mockReturnValue(pending);
    const controller = new AbortController();
    const capture = captureGlobalDictationBareModifierHotkey(controller.signal, true);
    controller.abort();
    expect(invokeRendererControl).toHaveBeenCalledExactlyOnceWith(
      "global-dictation-hotkey-capture:cancel",
    );
    resolve("Shift+Fn");
    expect(await capture).toBeNull();
  });

  test("does not open an already-aborted capture or cancel a later session", async () => {
    const aborted = AbortSignal.abort();
    expect(await captureGlobalDictationBareModifierHotkey(aborted, true)).toBeNull();
    expect(invokeRendererQuery).not.toHaveBeenCalled();
    const controller = new AbortController();
    vi.mocked(invokeRendererQuery).mockResolvedValue("Fn");
    expect(await captureGlobalDictationBareModifierHotkey(controller.signal, true)).toBe("Fn");
    controller.abort();
    expect(invokeRendererControl).not.toHaveBeenCalled();
  });
});
