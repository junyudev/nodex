import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { VoiceSettingsPage } from "./voice-settings-page";

const mocks = vi.hoisted(() => ({
  requestInputMonitoring: vi.fn(),
  requestAccessibility: vi.fn(),
  setKeybinding: vi.fn(),
  updateSettings: vi.fn(),
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
  listDictationRecordings: async () => [],
  openGlobalDictationAccessibilitySettings: vi.fn(),
  openGlobalDictationInputMonitoringSettings: vi.fn(),
  openMicrophoneSettings: vi.fn(),
  readDictationCapabilityState: async () => ({
    isEnabled: false,
    authMethod: "apiKey",
    shortcutLabel: "Ctrl+M",
    capabilities: {
      composer: false,
      global: false,
      history: true,
      streaming: "unavailable",
      semanticCleanup: false,
      microphoneOwner: "none",
      auth: "unsupported",
    },
  }),
  readDictationRecordingAudio: vi.fn(),
  readDictationSettings: async () => ({
    microphoneInputDeviceId: "missing-microphone",
    keepGlobalBarVisible: false,
    playStartSound: true,
    playStopSound: true,
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
  setDictationRecordingTranscript: vi.fn(),
  updateDictationSettings: mocks.updateSettings,
}));

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VoiceSettingsPage onPathChange={() => undefined} />
    </QueryClientProvider>,
  );
};

describe("VoiceSettingsPage", () => {
  beforeEach(() => {
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
      keepGlobalBarVisible: false,
      playStartSound: true,
      playStopSound: true,
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

  test("explains auth requirements, preserves a missing selection, and separates macOS permissions", async () => {
    renderPage();

    expect(
      await screen.findByText(
        "Dictation requires a ChatGPT login. API-key sessions cannot use Voice transcription.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Unavailable microphone")).toBeTruthy();
    expect(screen.getByText("Input Monitoring")).toBeTruthy();
    expect(screen.getByText("Accessibility")).toBeTruthy();

    const allowButtons = screen.getAllByRole("button", { name: "Allow" });
    fireEvent.click(allowButtons[0]!);
    fireEvent.click(allowButtons[1]!);
    await vi.waitFor(() => {
      expect(mocks.requestInputMonitoring).toHaveBeenCalledOnce();
      expect(mocks.requestAccessibility).toHaveBeenCalledOnce();
    });
  });

  test("edits dictation hotkeys inline and waits for the non-modifier key", async () => {
    renderPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Change shortcut for Toggle dictation hotkey",
      }),
    );
    const capture = screen.getByRole("textbox", {
      name: "Toggle dictation hotkey capture",
    });
    fireEvent.keyDown(capture, {
      code: "ControlLeft",
      ctrlKey: true,
      key: "Control",
      location: 1,
    });
    expect(mocks.setKeybinding).not.toHaveBeenCalled();

    fireEvent.keyDown(capture, {
      code: "KeyY",
      ctrlKey: true,
      key: "y",
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
        name: "Change shortcut for Toggle dictation hotkey",
      }),
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Toggle dictation hotkey capture" }), {
      code: "KeyY",
      key: "y",
    });

    expect(await screen.findByText("Shortcut must include Cmd/Ctrl or Alt.")).toBeTruthy();
    expect(mocks.setKeybinding).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Change shortcut for Toggle dictation hotkey" }),
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
        name: "Change shortcut for Toggle dictation hotkey",
      }),
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Toggle dictation hotkey capture" }), {
      altKey: true,
      code: "KeyY",
      key: "¥",
    });

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
});
