import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { VoiceSettingsPage } from "./voice-settings-page";

const mocks = vi.hoisted(() => ({
  requestInputMonitoring: vi.fn(),
  requestAccessibility: vi.fn(),
  setKeybinding: vi.fn(),
  updateSettings: vi.fn(),
  readCapabilities: vi.fn(),
  readLanguage: vi.fn(),
  updateLanguage: vi.fn(),
  listRecordings: vi.fn(),
  readRecordingAudio: vi.fn(),
  setTranscript: vi.fn(),
  setDiagnostics: vi.fn(),
  transcribe: vi.fn(),
  subscribeUpdates: vi.fn(),
}));

vi.mock("./dictation-settings-runtime", () => ({
  captureGlobalDictationBareModifierHotkey: vi.fn(async () => null),
  readDictationVoiceLanguage: mocks.readLanguage,
  updateDictationVoiceLanguage: mocks.updateLanguage,
  subscribeDictationSettingsUpdates: mocks.subscribeUpdates,
}));

vi.mock("./dictation-buffered-client", () => ({
  transcribeDictationBlob: mocks.transcribe,
}));

const commandKeymapState = {
  version: 1 as const,
  platform: "macOS" as const,
  hasCustomBindings: true,
  entries: [
    {
      id: "globalDictationHold",
      title: "Hold to dictate",
      description: "Hold the global dictation hotkey",
      order: 320,
      shortcutScope: "os-global" as const,
      defaultKeybindings: [],
      keybindings: [{ key: "Fn" }],
      customKeybindings: [{ key: "Fn" }],
      isCustom: true,
      hasDefault: false,
      available: true,
      allowsBareModifiers: true,
    },
    {
      id: "globalDictationToggle",
      title: "Toggle dictation",
      description: "Toggle global dictation",
      order: 330,
      shortcutScope: "os-global" as const,
      defaultKeybindings: [],
      keybindings: [{ key: "Ctrl+Space" }],
      customKeybindings: [{ key: "Ctrl+Space" }],
      isCustom: true,
      hasDefault: false,
      available: true,
      allowsBareModifiers: true,
    },
  ],
};

vi.mock("@/lib/use-command-keymap-state", () => ({
  useCommandKeymapState: () => ({ data: commandKeymapState }),
  updateCommandKeybinding: (...args: unknown[]) => mocks.setKeybinding(...args),
}));

vi.mock("@/lib/api", () => ({
  deleteDictationRecording: vi.fn(),
  downloadDictationRecording: vi.fn(),
  listDictationRecordings: mocks.listRecordings,
  openGlobalDictationAccessibilitySettings: vi.fn(),
  openGlobalDictationInputMonitoringSettings: vi.fn(),
  openMicrophoneSettings: vi.fn(),
  readDictationCapabilityState: mocks.readCapabilities,
  readDictationRecordingAudio: mocks.readRecordingAudio,
  readDictationSettings: async () => ({
    microphoneInputDeviceId: "missing-microphone",
    dictationSoundsEnabled: true,
    globalShortcutNudgeDismissed: false,
    dictionary: [],
  }),
  readGlobalDictationPermissions: async () => ({
    available: true,
    inputMonitoring: false,
    accessibility: false,
  }),
  readMicrophoneAccess: async () => "granted",
  requestMicrophoneAccess: vi.fn(),
  requestGlobalDictationAccessibility: mocks.requestAccessibility,
  requestGlobalDictationInputMonitoring: mocks.requestInputMonitoring,
  setDictationRecordingTranscript: mocks.setTranscript,
  setDictationRecordingDiagnostics: mocks.setDiagnostics,
  updateDictationSettings: mocks.updateSettings,
}));

const defaultCapability = {
  isEnabled: true,
  authMethod: "chatgpt",
  shortcutLabel: "Ctrl+M",
  capabilities: {
    composer: true,
    global: true,
    history: true,
    streaming: "unavailable",
    semanticCleanup: false,
    sounds: false,
    voiceDictionary: false,
    microphoneOwner: "none",
    auth: "chatgpt",
  },
};

const renderPage = (path = "/settings/voice") => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VoiceSettingsPage path={path} onPathChange={() => undefined} />
    </QueryClientProvider>,
  );
};

describe("VoiceSettingsPage", () => {
  beforeEach(() => {
    mocks.subscribeUpdates.mockReset().mockReturnValue(() => undefined);
    mocks.readCapabilities.mockReset().mockResolvedValue(defaultCapability);
    mocks.readLanguage.mockReset().mockResolvedValue("auto");
    mocks.updateLanguage.mockReset().mockImplementation(async (language) => language);
    mocks.listRecordings.mockReset().mockResolvedValue([]);
    mocks.readRecordingAudio.mockReset();
    mocks.setTranscript.mockReset().mockResolvedValue(undefined);
    mocks.setDiagnostics.mockReset().mockResolvedValue(undefined);
    mocks.transcribe.mockReset();
    mocks.requestInputMonitoring.mockReset().mockResolvedValue({
      available: true,
      inputMonitoring: true,
      accessibility: false,
    });
    mocks.requestAccessibility.mockReset().mockResolvedValue({
      available: true,
      inputMonitoring: false,
      accessibility: true,
    });
    mocks.setKeybinding
      .mockReset()
      .mockResolvedValue({ type: "applied", state: commandKeymapState });
    mocks.updateSettings.mockReset().mockImplementation(async (patch) => ({
      microphoneInputDeviceId: "missing-microphone",
      dictationSoundsEnabled: true,
      globalShortcutNudgeDismissed: false,
      dictionary: [],
      ...patch,
    }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
      },
    });
  });

  test("keeps the selected microphone and hides unsupported dictation settings", async () => {
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      capabilities: { ...defaultCapability.capabilities, composer: false, global: false },
    });
    renderPage();
    expect(await screen.findByText("Selected microphone")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Change shortcut for Hands-free dictation hotkey" }),
    ).toBeNull();
    expect(mocks.readLanguage).not.toHaveBeenCalled();
  });

  test("edits dictation hotkeys inline and waits for the non-modifier key", async () => {
    renderPage();

    const trigger = await screen.findByRole("button", {
      name: "Change shortcut for Hands-free dictation hotkey",
    });
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const capture = screen.getByRole("textbox", {
      name: "Hands-free dictation hotkey capture",
    });
    await act(async () => {
      fireEvent.keyDown(capture, {
        code: "ControlLeft",
        ctrlKey: true,
        key: "Control",
        location: 1,
      });
      await Promise.resolve();
    });
    expect(mocks.setKeybinding).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(capture, {
        code: "KeyY",
        ctrlKey: true,
        key: "y",
      });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mocks.setKeybinding).toHaveBeenCalledWith("globalDictationToggle", {
        type: "replace",
        oldKeybinding: { key: "Ctrl+Space" },
        newKeybinding: { key: "Ctrl+Y" },
      });
    });
  });

  test("rejects an unmodified global shortcut with the native validation message", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Change shortcut for Hands-free dictation hotkey",
      }),
    );
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Hands-free dictation hotkey capture" }),
      {
        code: "KeyY",
        key: "y",
      },
    );

    expect(await screen.findByText("Shortcut must include Cmd/Ctrl or Alt.")).toBeTruthy();
    expect(mocks.setKeybinding).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Change shortcut for Hands-free dictation hotkey" }),
    ).toBeTruthy();
  });

  test("renders a typed native rejection instead of an IPC exception", async () => {
    mocks.setKeybinding.mockResolvedValueOnce({
      type: "rejected",
      state: commandKeymapState,
      reason: {
        kind: "permission-required",
        message: "Input Monitoring permission is required for global shortcuts.",
      },
    });
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Change shortcut for Hands-free dictation hotkey",
      }),
    );
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Hands-free dictation hotkey capture" }),
      {
        altKey: true,
        code: "KeyY",
        key: "¥",
      },
    );

    expect(
      await screen.findByText("Input Monitoring permission is required for global shortcuts."),
    ).toBeTruthy();
  });

  test("edits the dictation dictionary inline and trims entries on blur", async () => {
    renderPage();

    const firstEntry = await screen.findByRole("textbox", { name: "Dictionary entry 1" });
    await act(async () => {
      fireEvent.change(firstEntry, { target: { value: "  Nodex  " } });
      fireEvent.blur(firstEntry);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(mocks.updateSettings).toHaveBeenCalledWith(
        { dictionary: ["Nodex"] },
        expect.anything(),
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("textbox", { name: "Dictionary entry 2" })).toBeTruthy();
  });
  test("updates the visible language using the account setting", async () => {
    renderPage();
    const trigger = await screen.findByRole("button", { name: "Auto-detect" });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("menuitem", { name: "Japanese" }));
    });
    await vi.waitFor(() =>
      expect(mocks.updateLanguage).toHaveBeenCalledWith("ja", expect.anything()),
    );
  });

  test("retries saved audio without semantic rewriting and focuses the requested recording", async () => {
    const recording = {
      id: "recording-id",
      createdAtMs: 1,
      status: "interrupted",
      transcript: null,
      sizeBytes: 10,
      mimeType: "audio/webm",
      durationMs: 500,
    };
    mocks.listRecordings.mockResolvedValue([recording]);
    mocks.readRecordingAudio.mockResolvedValue({ recording, bytes: [1, 2] });
    mocks.transcribe.mockResolvedValue("  um keep my original wording  ");
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    renderPage("/settings/voice?recording=recording-id");
    const retry = await screen.findByRole("button", { name: "Retry" });
    await act(async () => {
      fireEvent.click(retry);
    });
    await vi.waitFor(() =>
      expect(mocks.setTranscript).toHaveBeenCalledWith({
        id: "recording-id",
        transcript: "um keep my original wording",
      }),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });
  test("updates settings visibility after asynchronous account policy arrives", async () => {
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      capabilities: { ...defaultCapability.capabilities, composer: false, global: false },
    });
    renderPage();
    await screen.findByText("Selected microphone");
    expect(
      screen.queryByRole("button", { name: "Change shortcut for Hands-free dictation hotkey" }),
    ).toBeNull();
    await act(async () => {
      mocks.subscribeUpdates.mock.calls[0]?.[0]({ type: "capabilities", state: defaultCapability });
    });
    expect(
      await screen.findByRole("button", {
        name: "Change shortcut for Hands-free dictation hotkey",
      }),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Auto-detect" })).toBeTruthy();
  });
});
