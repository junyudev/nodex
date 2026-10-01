import { StrictMode } from "react";
import { Blob as NodeBlob } from "node:buffer";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DICTATION_SETTINGS } from "../../../shared/dictation";
import type {
  GlobalDictationRendererCommand,
  GlobalDictationRendererEvent,
} from "../../../shared/global-dictation";
import {
  emptyDictationStreamDiagnostics,
  type DictationDiagnostics,
  type DictationTextResult,
} from "../../../shared/dictation-diagnostics";
import { browserDictationRecorderFactory } from "./dictation-recorder";
import type { DictationStreamingAttempt } from "./dictation-session-controller";
import * as streamingClient from "./dictation-streaming-client";
import { browserGlobalDictationCompactWaveformPort } from "./global-dictation-compact-waveform";
import {
  GlobalDictationBar,
  GlobalDictationRoot,
  GlobalDictationPasteRecovery,
  GlobalDictationTranscriptionRecovery,
} from "./global-dictation-page";

const mocks = vi.hoisted(() => ({ playSound: vi.fn() }));

vi.mock("./dictation-sounds", () => ({ playDictationSound: mocks.playSound }));

describe("GlobalDictationBar", () => {
  it("exposes retry and dismiss actions in an actionable error state", () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    render(
      <GlobalDictationBar
        state="error"
        waveform={[]}
        error={{ kind: "paste-failed", operation: "paste", retryable: true }}
        onDismiss={onDismiss}
        onRetry={onRetry}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.getAllByText("Couldn’t paste text")).toHaveLength(2);
  });

  it("keeps permission errors compact and actionable", () => {
    render(
      <GlobalDictationBar
        state="error"
        waveform={[]}
        error={{ kind: "accessibility-denied", operation: "paste", retryable: true }}
        onDismiss={() => undefined}
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText("Accessibility access is required")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("renders the live waveform without adding retry during capture", () => {
    const { container } = render(
      <GlobalDictationBar
        state="listening"
        waveform={[0.02, 0.08, 0.04, 0.06]}
        onDismiss={() => undefined}
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("Listening")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("replaces the waveform with the transcribing status as soon as capture stops", () => {
    const props = {
      waveform: [0.02, 0.08, 0.04, 0.06],
      onDismiss: () => undefined,
      onRetry: () => undefined,
      onClose: () => undefined,
    } as const;
    const { container, rerender } = render(<GlobalDictationBar state="listening" {...props} />);
    expect(container.querySelector("canvas")).not.toBeNull();

    rerender(<GlobalDictationBar state="transcribing" {...props} />);

    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByText("Transcribing…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("GlobalDictationRoot", () => {
  it.each(["available", "read-failed"] as const)(
    "preserves %s streaming admission through capture, transcription, and history",
    async (availability) => {
      let now = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const blobDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Blob");
      Object.defineProperty(globalThis, "Blob", { configurable: true, value: NodeBlob });
      const trackStop = vi.fn();
      const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
      const getUserMedia = vi.fn(async () => stream);
      const deviceDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia, enumerateDevices: async () => [] },
      });
      const recorder = vi
        .spyOn(browserDictationRecorderFactory, "create")
        .mockImplementation((_stream, callbacks) => {
          let state: "inactive" | "recording" = "inactive";
          return {
            mimeType: "audio/webm",
            get state() {
              return state;
            },
            start: () => {
              state = "recording";
            },
            stop: () => {
              state = "inactive";
              callbacks.onChunk(new Blob(["retained audio"], { type: "audio/webm" }));
              callbacks.onStop();
            },
            dispose: () => undefined,
          };
        });
      const waveform = vi
        .spyOn(browserGlobalDictationCompactWaveformPort, "start")
        .mockReturnValue({ dispose: () => undefined });
      const attempt = {
        start: vi.fn(async () => undefined),
        split: () => null,
        hasBoundaries: () => false,
        recover: async () => "",
        stopAndFlush: vi.fn(async () => undefined),
        finish: vi.fn(async () => "Streaming words."),
        abort: vi.fn(),
        diagnostics: () => ({
          ...emptyDictationStreamDiagnostics(),
          attempted: true,
          opened: true,
          started: true,
          finalReceived: true,
        }),
      } satisfies DictationStreamingAttempt;
      const prepareStreaming = vi.fn(async () => attempt);
      const streaming = vi
        .spyOn(streamingClient, "createBrowserDictationStreamingPort")
        .mockReturnValue({ prepare: prepareStreaming });
      const handlers = new Set<(command: GlobalDictationRendererCommand) => void>();
      const emit = (command: GlobalDictationRendererCommand): void => {
        for (const handler of handlers) handler(command);
      };
      const sendEvent = vi.fn(async (event: GlobalDictationRendererEvent) => {
        if (event.type === "completed")
          queueMicrotask(() =>
            emit({ type: "paste-completed", sessionId: event.sessionId, clipboardRestoreMs: 0 }),
          );
        return true;
      });
      const transcribe = vi.fn(
        async (input: { requestId: string }): Promise<DictationTextResult> => ({
          text: "Buffered words.",
          diagnostics: {
            operation: "transcription",
            requestId: input.requestId,
            endpoint: "/transcribe",
            outcome: "completed",
            status: 200,
            totalMs: 1,
            attempts: 1,
          },
        }),
      );
      const reports: DictationDiagnostics[] = [];
      const invoke = vi.fn(async (channel: string, input?: unknown) => {
        if (channel === "codex:dictation:state:read") {
          if (availability === "read-failed") throw new Error("Capability query rejected");
          return { capabilities: { sounds: false, streaming: "available" } };
        }
        if (channel === "codex:dictation:settings:read") return DEFAULT_DICTATION_SETTINGS;
        if (channel === "codex:dictation:microphone-lease:acquire") return true;
        if (channel === "codex:dictation:microphone-access:request")
          return { kind: "granted", status: "granted" };
        if (channel === "codex:dictation:transcribe")
          return await transcribe(input as { requestId: string });
        if (channel === "codex:dictation:history:set-diagnostics")
          reports.push((input as { diagnostics: DictationDiagnostics }).diagnostics);
        return null;
      });
      const bridgeDescriptor = Object.getOwnPropertyDescriptor(window, "globalDictation");
      Object.defineProperty(window, "globalDictation", {
        configurable: true,
        value: {
          invoke,
          sendEvent,
          onCommand: (handler: (command: GlobalDictationRendererCommand) => void) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
          },
          showContextMenu: async () => null,
        },
      });
      const { unmount } = render(<GlobalDictationRoot />);
      try {
        await waitFor(() => expect(sendEvent).toHaveBeenCalledWith({ type: "ready" }));
        await act(async () => {
          emit({
            type: "start",
            sessionId: "admission-session",
            requestId: "admission-request",
            deadlineAtMs: Date.now() + 5000,
            gesture: "toggle",
          });
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(sendEvent).toHaveBeenCalledWith({
            type: "state",
            sessionId: "admission-session",
            state: "listening",
          }),
        );
        expect(getUserMedia).toHaveBeenCalledOnce();
        expect(recorder).toHaveBeenCalledOnce();
        await act(async () => {
          now = 1000;
          emit({ type: "stop", sessionId: "admission-session" });
          await Promise.resolve();
        });
        await waitFor(() => expect(reports).toHaveLength(1));
        expect(sendEvent).toHaveBeenCalledWith({
          type: "completed",
          sessionId: "admission-session",
          transcript: availability === "available" ? "Streaming words." : "Buffered words.",
        });
        expect(trackStop).toHaveBeenCalledOnce();
        if (availability === "available") {
          expect(prepareStreaming).toHaveBeenCalledOnce();
          expect(attempt.start).toHaveBeenCalledWith(
            stream,
            expect.any(Promise),
            expect.any(Function),
          );
          expect(transcribe).not.toHaveBeenCalled();
          expect(reports[0]).toMatchObject({
            outcome: "completed",
            transport: "websocket",
            streaming: { attempted: true, opened: true, started: true, finalReceived: true },
          });
          return;
        }
        expect(prepareStreaming).not.toHaveBeenCalled();
        expect(transcribe).toHaveBeenCalledOnce();
        expect(reports[0]).toMatchObject({
          outcome: "completed",
          transport: "buffered",
          streaming: { attempted: false, failureCode: "capability-read-failed" },
          requests: [{ operation: "transcription", status: 200 }],
        });
      } finally {
        await act(async () => unmount());
        streaming.mockRestore();
        recorder.mockRestore();
        waveform.mockRestore();
        clock.mockRestore();
        if (bridgeDescriptor) Object.defineProperty(window, "globalDictation", bridgeDescriptor);
        else Reflect.deleteProperty(window, "globalDictation");
        if (deviceDescriptor) Object.defineProperty(navigator, "mediaDevices", deviceDescriptor);
        else Reflect.deleteProperty(navigator, "mediaDevices");
        if (blobDescriptor) Object.defineProperty(globalThis, "Blob", blobDescriptor);
        else Reflect.deleteProperty(globalThis, "Blob");
      }
    },
  );

  it.each([
    { preference: false, capability: true, sounds: [] },
    { preference: true, capability: true, sounds: ["start", "stop"] },
    { preference: true, capability: false, sounds: [] },
  ])(
    "honors sound preference $preference and capability $capability without suppressing capture",
    async ({ preference, capability, sounds }) => {
      mocks.playSound.mockReset();
      const trackStop = vi.fn();
      const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
      const getUserMedia = vi.fn(async () => stream);
      const deviceDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia, enumerateDevices: async () => [] },
      });
      const recorderStart = vi.fn();
      const recorderStop = vi.fn();
      const recorder = vi
        .spyOn(browserDictationRecorderFactory, "create")
        .mockImplementation((_stream, callbacks) => ({
          mimeType: "audio/webm",
          state: "recording",
          start: recorderStart,
          stop: () => {
            recorderStop();
            callbacks.onStop();
          },
          dispose: () => undefined,
        }));
      const waveform = vi
        .spyOn(browserGlobalDictationCompactWaveformPort, "start")
        .mockReturnValue({ dispose: () => undefined });
      const sendEvent = vi.fn(async () => true);
      const invoke = vi.fn(async (channel: string) => {
        if (channel === "codex:dictation:microphone-lease:acquire") return true;
        if (channel === "codex:dictation:microphone-access:request")
          return { kind: "granted", status: "granted" };
        if (channel === "codex:dictation:settings:read")
          return { ...DEFAULT_DICTATION_SETTINGS, dictationSoundsEnabled: preference };
        if (channel === "codex:dictation:state:read")
          return { capabilities: { sounds: capability, streaming: "unavailable" } };
        return null;
      });
      const commandHandlers = new Set<(command: GlobalDictationRendererCommand) => void>();
      const bridgeDescriptor = Object.getOwnPropertyDescriptor(window, "globalDictation");
      Object.defineProperty(window, "globalDictation", {
        configurable: true,
        value: {
          invoke,
          sendEvent,
          onCommand: (callback: (command: GlobalDictationRendererCommand) => void) => {
            commandHandlers.add(callback);
            return () => commandHandlers.delete(callback);
          },
          showContextMenu: async () => null,
        },
      });
      const { unmount } = render(<GlobalDictationRoot />);
      try {
        await waitFor(() => expect(sendEvent).toHaveBeenCalledWith({ type: "ready" }));
        await act(async () => {
          commandHandlers.forEach((handler) =>
            handler({
              type: "start",
              sessionId: "sound-session",
              requestId: "sound-request",
              deadlineAtMs: Date.now() + 5000,
              gesture: "toggle",
            }),
          );
        });
        await waitFor(() =>
          expect(sendEvent).toHaveBeenCalledWith({
            type: "state",
            sessionId: "sound-session",
            state: "listening",
          }),
        );
        expect(getUserMedia).toHaveBeenCalledOnce();
        expect(recorderStart).toHaveBeenCalledOnce();
        await act(async () => {
          commandHandlers.forEach((handler) =>
            handler({ type: "stop", sessionId: "sound-session" }),
          );
        });
        await waitFor(() => expect(trackStop).toHaveBeenCalledOnce());
        expect(recorderStop).toHaveBeenCalledOnce();
        expect(sendEvent).toHaveBeenCalledWith({
          type: "recording-stopped",
          sessionId: "sound-session",
        });
        expect(mocks.playSound.mock.calls.map(([kind]) => kind)).toEqual(sounds);
      } finally {
        await act(async () => unmount());
        recorder.mockRestore();
        waveform.mockRestore();
        if (bridgeDescriptor) Object.defineProperty(window, "globalDictation", bridgeDescriptor);
        else Reflect.deleteProperty(window, "globalDictation");
        if (deviceDescriptor) Object.defineProperty(navigator, "mediaDevices", deviceDescriptor);
        else Reflect.deleteProperty(navigator, "mediaDevices");
      }
    },
  );

  it("accepts capture commands after Strict Mode effect replay through the restricted bridge", async () => {
    const sendEvent = vi.fn(async () => true);
    const commandHandlers: Array<
      (command: import("../../../shared/global-dictation").GlobalDictationRendererCommand) => void
    > = [];
    const acquireLease = vi.fn(async () => false);
    const descriptor = Object.getOwnPropertyDescriptor(window, "globalDictation");
    Object.defineProperty(window, "globalDictation", {
      configurable: true,
      value: {
        invoke: async (channel: string) =>
          channel === "codex:dictation:microphone-lease:acquire"
            ? acquireLease()
            : channel === "codex:dictation:settings:read"
              ? {
                  microphoneInputDeviceId: null,
                  dictationSoundsEnabled: true,
                  globalShortcutNudgeDismissed: false,
                  dictionary: [],
                }
              : null,
        onCommand: (callback: (typeof commandHandlers)[number]) => {
          commandHandlers.push(callback);
          return () => {
            commandHandlers.length = 0;
          };
        },
        sendEvent,
        showContextMenu: async () => null,
      },
    });
    try {
      const { unmount } = render(
        <StrictMode>
          <GlobalDictationRoot />
        </StrictMode>,
      );
      await waitFor(() => expect(sendEvent).toHaveBeenCalledWith({ type: "ready" }));
      expect(screen.queryByText("Dictation ready")).toBeNull();
      await act(async () => {
        commandHandlers[0]?.({
          type: "idle",
          configuredHotkey: "Fn",
          configuredToggleHotkey: "Command+Shift+D",
        });
        await Promise.resolve();
      });
      await screen.findByText("Dictation ready");
      await act(async () => {
        commandHandlers[0]?.({
          type: "start",
          sessionId: "global-session",
          requestId: "capture-request",
          deadlineAtMs: Date.now() + 5000,
          gesture: "toggle",
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(acquireLease).toHaveBeenCalledOnce());
      await act(async () => {
        unmount();
        await Promise.resolve();
      });
    } finally {
      if (descriptor) Object.defineProperty(window, "globalDictation", descriptor);
      else Reflect.deleteProperty(window, "globalDictation");
    }
  });
});

describe("global dictation recovery actions", () => {
  it("requires an explicit copy after recovery and reveals only saved recordings", async () => {
    const onCopy = vi.fn();
    const onViewRecording = vi.fn();
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const props = { onCopy, onViewRecording, onRetry, onDismiss };
    const { rerender } = render(
      <GlobalDictationTranscriptionRecovery
        {...props}
        recovery={{
          recordingId: "recording",
          phase: "recovering",
          text: null,
          saveState: "saving",
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View recording" })).toBeNull();
    rerender(
      <GlobalDictationTranscriptionRecovery
        {...props}
        recovery={{
          recordingId: "recording",
          phase: "recovered",
          text: "Recovered words",
          saveState: "saved",
        }}
      />,
    );
    expect(onCopy).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
      fireEvent.click(screen.getByRole("button", { name: "View recording" }));
    });
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onViewRecording).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("offers clipboard recovery without overwriting a changed clipboard automatically", async () => {
    const onCopy = vi.fn();
    const onOpenSettings = vi.fn();
    const onDismiss = vi.fn();
    const props = { onCopy, onOpenSettings, onDismiss };
    const { rerender } = render(
      <GlobalDictationPasteRecovery
        {...props}
        failure={{ text: "words", copied: false, reason: "clipboard-changed" }}
      />,
    );
    expect(onCopy).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript" }));
    });
    expect(onCopy).toHaveBeenCalledOnce();
    rerender(
      <GlobalDictationPasteRecovery
        {...props}
        failure={{ text: "words", copied: true, reason: "accessibility" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Copy transcript" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    });
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});
