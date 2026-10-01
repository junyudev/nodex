import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DictationRecordingMetadata } from "../../../shared/dictation-history";
import { createCommandKeymapState } from "../../../shared/command-keybindings";
import { VoiceSettingsPage } from "./voice-settings-page";

const mocks = vi.hoisted(() => ({
  requestInputMonitoring: vi.fn(),
  requestAccessibility: vi.fn(),
  setKeybinding: vi.fn(),
  readKeymap: vi.fn(),
  captureShortcut: vi.fn(),
  updateSettings: vi.fn(),
  readCapabilities: vi.fn(),
  readLanguage: vi.fn(),
  updateLanguage: vi.fn(),
  listRecordings: vi.fn(),
  importRecording: vi.fn(),
  readRecordingAudio: vi.fn(),
  setTranscript: vi.fn(),
  setDiagnostics: vi.fn(),
  transcribe: vi.fn(),
  subscribeUpdates: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: { success: mocks.toastSuccess, danger: mocks.toastDanger },
}));

vi.mock("./dictation-settings-runtime", () => ({
  captureGlobalDictationBareModifierHotkey: mocks.captureShortcut,
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
      title: "Dictation shortcut",
      description: "Hold to dictate, or double-tap for hands-free",
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
      title: "Single-tap shortcut",
      description: "Press once to start, and again to finish",
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
  useCommandKeymapState: () => ({ data: mocks.readKeymap() }),
  updateCommandKeybinding: (...args: unknown[]) => mocks.setKeybinding(...args),
}));

vi.mock("@/lib/api", () => ({
  deleteDictationRecording: vi.fn(),
  downloadDictationRecording: vi.fn(),
  importDictationRecordingFile: mocks.importRecording,
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

const savedRecording = (
  overrides: Partial<DictationRecordingMetadata> = {},
): DictationRecordingMetadata => ({
  schemaVersion: 1,
  id: "recording-id",
  createdAtMs: 1,
  updatedAtMs: 1,
  status: "completed",
  sizeBytes: 2,
  chunkCount: 1,
  mimeType: "audio/webm",
  durationMs: 500,
  surface: "composer",
  ...overrides,
});

let recordings: DictationRecordingMetadata[];

const prepareWebmImport = (): DictationRecordingMetadata => {
  const recording = savedRecording({ surface: "file", fileName: "interview.webm" });
  mocks.importRecording.mockImplementation(async () => {
    recordings = [recording, ...recordings];
    return recording;
  });
  mocks.readRecordingAudio.mockResolvedValue({ recording, bytes: Uint8Array.from([1, 2]) });
  return recording;
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
    recordings = [];
    mocks.toastSuccess.mockReset();
    mocks.toastDanger.mockReset();
    mocks.readKeymap.mockReset().mockReturnValue(commandKeymapState);
    mocks.captureShortcut.mockReset().mockResolvedValue(null);
    mocks.subscribeUpdates.mockReset().mockReturnValue(() => undefined);
    mocks.readCapabilities.mockReset().mockResolvedValue(defaultCapability);
    mocks.readLanguage.mockReset().mockResolvedValue("auto");
    mocks.updateLanguage.mockReset().mockImplementation(async (language) => language);
    mocks.listRecordings.mockReset().mockImplementation(async () => recordings);
    mocks.importRecording.mockReset().mockResolvedValue(null);
    mocks.readRecordingAudio.mockReset();
    mocks.setTranscript.mockReset().mockImplementation(async ({ id, transcript }) => {
      recordings = recordings.map((recording) =>
        recording.id === id ? { ...recording, transcript: transcript ?? undefined } : recording,
      );
      return recordings.find((recording) => recording.id === id);
    });
    mocks.setDiagnostics.mockReset().mockImplementation(async ({ id, diagnostics }) => {
      recordings = recordings.map((recording) =>
        recording.id === id ? { ...recording, diagnostics } : recording,
      );
      return recordings.find((recording) => recording.id === id);
    });
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

  test("keeps global configuration when capture is unavailable", async () => {
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      capabilities: { ...defaultCapability.capabilities, composer: false, global: false },
    });
    renderPage();
    expect(await screen.findByText("Selected microphone")).toBeTruthy();
    expect(
      await screen.findByRole("button", {
        name: "Change shortcut for Dictation shortcut",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Change shortcut for Single-tap shortcut" }),
    ).toBeNull();
    const advanced = screen.getByRole("button", { name: "Advanced" });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(advanced);
    });
    expect(
      screen.getByRole("button", { name: "Change shortcut for Single-tap shortcut" }),
    ).toBeTruthy();
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("textbox", { name: "Dictionary entry 1" })).toBeTruthy();
    expect(mocks.readLanguage).not.toHaveBeenCalled();
  });

  test("edits global shortcuts and the local dictionary while only Composer capture is enabled", async () => {
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      capabilities: { ...defaultCapability.capabilities, global: false, sounds: false },
    });
    renderPage();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    });
    const toggle = await screen.findByRole("button", {
      name: "Change shortcut for Single-tap shortcut",
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Single-tap shortcut capture" }), {
        code: "KeyY",
        ctrlKey: true,
        key: "y",
      });
    });
    await waitFor(() =>
      expect(mocks.setKeybinding).toHaveBeenCalledWith("globalDictationToggle", {
        type: "replace",
        oldKeybinding: { key: "Ctrl+Space" },
        newKeybinding: { key: "Ctrl+Y" },
      }),
    );
    const hold = screen.getByRole("button", {
      name: "Change shortcut for Dictation shortcut",
    });
    await act(async () => {
      fireEvent.click(hold);
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Dictation shortcut capture" }), {
        code: "KeyT",
        altKey: true,
        key: "t",
      });
    });
    await waitFor(() =>
      expect(mocks.setKeybinding).toHaveBeenCalledWith("globalDictationHold", {
        type: "replace",
        oldKeybinding: { key: "Fn" },
        newKeybinding: { key: "Alt+T" },
      }),
    );
    expect(mocks.setKeybinding).toHaveBeenCalledTimes(2);
    const dictionary = screen.getByRole("textbox", { name: "Dictionary entry 1" });
    await act(async () => {
      fireEvent.change(dictionary, { target: { value: "Nodex" } });
      fireEvent.blur(dictionary);
    });
    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith(
        { dictionary: ["Nodex"] },
        expect.anything(),
      ),
    );
    expect(screen.queryByRole("switch", { name: "Toggle dictation sounds" })).toBeNull();
  });

  test("omits an empty Dictation section on a platform without global shortcuts", async () => {
    mocks.readKeymap.mockReturnValue(createCommandKeymapState({}, "linux"));
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      capabilities: { ...defaultCapability.capabilities, global: false, sounds: false },
    });
    renderPage();
    await screen.findByRole("button", { name: "Auto-detect" });
    expect(screen.queryByRole("heading", { name: "Dictation" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Change shortcut for Dictation shortcut" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Advanced" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Dictionary entry 1" })).toBeNull();
  });

  test("edits the primary shortcut inline and waits for the non-modifier key", async () => {
    renderPage();

    const trigger = await screen.findByRole("button", {
      name: "Change shortcut for Dictation shortcut",
    });
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const capture = screen.getByRole("textbox", {
      name: "Dictation shortcut capture",
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
      expect(mocks.setKeybinding).toHaveBeenCalledWith("globalDictationHold", {
        type: "replace",
        oldKeybinding: { key: "Fn" },
        newKeybinding: { key: "Ctrl+Y" },
      });
    });
    expect(mocks.setKeybinding).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      commandId: "globalDictationHold",
      label: "Dictation shortcut",
      key: "Fn",
      otherLabel: "Single-tap shortcut",
    },
    {
      commandId: "globalDictationToggle",
      label: "Single-tap shortcut",
      key: "Ctrl+Space",
      otherLabel: "Dictation shortcut",
    },
  ])(
    "clears only $label and retains the independent binding",
    async ({ commandId, label, key, otherLabel }) => {
      const clearedState = {
        ...commandKeymapState,
        entries: commandKeymapState.entries.map((entry) =>
          entry.id === commandId ? { ...entry, keybindings: [], customKeybindings: [] } : entry,
        ),
      };
      mocks.setKeybinding.mockImplementationOnce(async () => {
        mocks.readKeymap.mockReturnValue(clearedState);
        return { type: "applied", state: clearedState };
      });
      renderPage();
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: `Clear shortcut for ${label}` }));
      });
      expect(await screen.findByRole("button", { name: `Set shortcut for ${label}` })).toBeTruthy();
      expect(
        screen.getByRole("button", { name: `Change shortcut for ${otherLabel}` }),
      ).toBeTruthy();
      expect(mocks.setKeybinding).toHaveBeenCalledExactlyOnceWith(commandId, {
        type: "remove",
        keybinding: { key },
      });
    },
  );

  test("closing Advanced cancels native single-tap capture without changing its binding", async () => {
    mocks.captureShortcut.mockReturnValue(new Promise<string | null>(() => undefined));
    renderPage();
    const advanced = await screen.findByRole("button", { name: "Advanced" });
    const panelId = advanced.getAttribute("aria-controls") ?? "";
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId)).toBeTruthy();
    await act(async () => {
      fireEvent.click(advanced);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Change shortcut for Single-tap shortcut" }),
      );
    });
    await screen.findByRole("textbox", { name: "Single-tap shortcut capture" });
    const signal: AbortSignal = mocks.captureShortcut.mock.calls[0]?.[0];
    expect(signal.aborted).toBe(false);
    await act(async () => {
      fireEvent.click(advanced);
    });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Single-tap shortcut capture" })).toBeNull();
    expect(document.getElementById(panelId)).toBeTruthy();
    await act(async () => {
      fireEvent.click(advanced);
    });
    expect(
      screen.getByRole("button", { name: "Change shortcut for Single-tap shortcut" }),
    ).toBeTruthy();
    expect(mocks.setKeybinding).not.toHaveBeenCalled();
  });

  test("rejects an unmodified global shortcut with the native validation message", async () => {
    renderPage();

    const trigger = await screen.findByRole("button", {
      name: "Change shortcut for Dictation shortcut",
    });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Dictation shortcut capture" }), {
        code: "KeyY",
        key: "y",
      });
    });

    expect(await screen.findByText("Shortcut must include Cmd/Ctrl or Alt.")).toBeTruthy();
    expect(mocks.setKeybinding).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Change shortcut for Dictation shortcut" }),
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

    const trigger = await screen.findByRole("button", {
      name: "Change shortcut for Dictation shortcut",
    });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Dictation shortcut capture" }), {
        altKey: true,
        code: "KeyY",
        key: "¥",
      });
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
    const recording = savedRecording({
      status: "interrupted",
      sizeBytes: 10,
    });
    recordings = [recording];
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

  test("imports and transcribes a WebM file into history without capture availability", async () => {
    const recording = prepareWebmImport();
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      capabilities: { ...defaultCapability.capabilities, composer: false, global: false },
    });
    let completeTranscription!: (text: string) => void;
    mocks.transcribe.mockReturnValue(
      new Promise<string>((resolve) => {
        completeTranscription = resolve;
      }),
    );
    renderPage();

    const selectFile = await screen.findByRole("button", { name: "Transcribe WebM…" });
    await act(async () => {
      fireEvent.click(selectFile);
    });
    expect(await screen.findByText("Transcribing…")).toBeTruthy();
    expect(screen.getByText(/interview\.webm/)).toBeTruthy();
    expect(selectFile.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(true);
    expect(mocks.readRecordingAudio).toHaveBeenCalledWith(recording.id);
    expect(mocks.readLanguage).not.toHaveBeenCalled();
    expect(mocks.transcribe.mock.calls[0]?.[0].type).toBe("audio/webm");
    expect(mocks.transcribe.mock.calls[0]?.[0].size).toBe(2);
    expect(mocks.transcribe.mock.calls[0]?.[1]).toEqual({
      filename: "interview.webm",
      signal: expect.any(AbortSignal),
      onDiagnostics: expect.any(Function),
    });

    await act(async () => {
      completeTranscription("  um keep my original wording\nsecond line  ");
    });
    expect(await screen.findByText("um keep my original wording second line")).toBeTruthy();
    expect(mocks.setTranscript).toHaveBeenCalledWith({
      id: recording.id,
      transcript: "um keep my original wording\nsecond line",
    });
    await waitFor(() => expect(selectFile.hasAttribute("disabled")).toBe(false));
    expect(recordings[0]?.transcript).toBe("um keep my original wording\nsecond line");
    expect(recordings[0]?.diagnostics).toMatchObject({
      attempt: 1,
      outcome: "completed",
      transport: "buffered",
      delivery: "history",
      source: "file",
    });
  });

  test("cancels file selection without uploading or creating a recording", async () => {
    let cancelSelection!: (recording: null) => void;
    mocks.importRecording.mockReturnValue(
      new Promise<null>((resolve) => {
        cancelSelection = resolve;
      }),
    );
    renderPage();
    const selectFile = await screen.findByRole("button", { name: "Transcribe WebM…" });
    await act(async () => {
      fireEvent.click(selectFile);
      fireEvent.click(selectFile);
    });
    await waitFor(() => expect(mocks.importRecording).toHaveBeenCalledOnce());
    expect(selectFile.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      cancelSelection(null);
    });
    expect(selectFile.hasAttribute("disabled")).toBe(false);
    expect(recordings).toEqual([]);
    expect(mocks.readRecordingAudio).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.toastDanger).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  test("reports a rejected WebM import without starting transcription", async () => {
    mocks.importRecording.mockRejectedValue(new Error("File is not WebM"));
    renderPage();
    const selectFile = await screen.findByRole("button", { name: "Transcribe WebM…" });
    await act(async () => {
      fireEvent.click(selectFile);
    });
    await waitFor(() =>
      expect(mocks.toastDanger).toHaveBeenCalledWith("Could not import this WebM file"),
    );
    expect(selectFile.hasAttribute("disabled")).toBe(false);
    expect(recordings).toEqual([]);
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  test("retains an imported file for retry after transcription fails", async () => {
    const recording = prepareWebmImport();
    mocks.transcribe
      .mockRejectedValueOnce(new Error("Transcription failed"))
      .mockResolvedValueOnce("retry succeeded");
    renderPage();
    const selectFile = await screen.findByRole("button", { name: "Transcribe WebM…" });
    await act(async () => {
      fireEvent.click(selectFile);
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    expect(recordings[0]).toMatchObject({
      id: recording.id,
      fileName: "interview.webm",
      diagnostics: { attempt: 1, outcome: "failed", source: "file" },
    });
    expect(mocks.setTranscript).not.toHaveBeenCalled();
    expect(mocks.toastDanger).toHaveBeenCalledWith("Could not transcribe this recording");

    await act(async () => {
      fireEvent.click(retry);
    });
    expect(await screen.findByText("retry succeeded")).toBeTruthy();
    await waitFor(() => expect(selectFile.hasAttribute("disabled")).toBe(false));
    expect(mocks.importRecording).toHaveBeenCalledOnce();
    expect(mocks.readRecordingAudio.mock.calls).toEqual([[recording.id], [recording.id]]);
    expect(recordings[0]?.diagnostics).toMatchObject({
      attempt: 2,
      outcome: "completed",
      source: "recovery",
    });
  });

  test("requires ChatGPT for file transcription while keeping local history visible", async () => {
    recordings = [
      savedRecording({ transcript: "Saved transcript" }),
      savedRecording({ id: "retry-id", surface: "file", fileName: "saved.webm" }),
    ];
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      authMethod: null,
      capabilities: {
        ...defaultCapability.capabilities,
        auth: "unsupported",
        composer: false,
        global: false,
      },
    });
    renderPage();
    const selectFile = await screen.findByRole("button", { name: "Transcribe WebM…" });
    expect(selectFile.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Copy transcript" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getAllByRole("button", { name: "Recording actions" })).toHaveLength(2);
    await act(async () => {
      fireEvent.click(selectFile);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(mocks.importRecording).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  test.each(["account-change", "unmount"])(
    "cancels a file transcription on %s and keeps its audio for retry",
    async (cancel) => {
      prepareWebmImport();
      let completeTranscription!: (text: string) => void;
      mocks.transcribe.mockReturnValue(
        new Promise<string>((resolve) => {
          completeTranscription = resolve;
        }),
      );
      const page = renderPage();
      const selectFile = await screen.findByRole("button", { name: "Transcribe WebM…" });
      await act(async () => {
        fireEvent.click(selectFile);
      });
      await screen.findByText("Transcribing…");
      const signal: AbortSignal = mocks.transcribe.mock.calls[0]?.[1].signal;
      await act(async () => {
        if (cancel === "unmount") page.unmount();
        else mocks.subscribeUpdates.mock.calls[0]?.[0]({ type: "account-changed" });
      });
      expect(signal.aborted).toBe(true);
      await act(async () => {
        completeTranscription("Result from the previous account");
      });
      await waitFor(() =>
        expect(recordings[0]?.diagnostics).toMatchObject({ outcome: "cancelled" }),
      );
      expect(recordings[0]).toMatchObject({ fileName: "interview.webm", sizeBytes: 2 });
      expect(mocks.setTranscript).not.toHaveBeenCalled();
      expect(mocks.toastDanger).not.toHaveBeenCalled();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
    },
  );

  test("keeps global configuration while asynchronous capture policy arrives", async () => {
    mocks.readCapabilities.mockResolvedValue({
      ...defaultCapability,
      capabilities: { ...defaultCapability.capabilities, composer: false, global: false },
    });
    renderPage();
    await screen.findByText("Selected microphone");
    expect(
      await screen.findByRole("button", {
        name: "Change shortcut for Dictation shortcut",
      }),
    ).toBeTruthy();
    await act(async () => {
      mocks.subscribeUpdates.mock.calls[0]?.[0]({ type: "capabilities", state: defaultCapability });
    });
    expect(
      await screen.findByRole("button", {
        name: "Change shortcut for Dictation shortcut",
      }),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Auto-detect" })).toBeTruthy();
  });
});
