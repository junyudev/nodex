import type { ReactNode } from "react";
import type {
  CodexRealtimeVoiceEvent,
  CodexRealtimeVoiceGrant,
} from "../../../../../shared/codex-realtime-voice";
import type {
  RealtimeVoiceMedia,
  RealtimeVoiceMediaInput,
} from "@/lib/realtime-voice/realtime-voice-media";
import type { RealtimeVoiceClient } from "@/features/realtime-voice/realtime-voice-client";
import { RealtimeVoiceWindowProvider } from "@/features/realtime-voice/realtime-voice-window";
import {
  createRealtimeVoiceWindowOwner,
  type RealtimeVoiceWindowOwner,
} from "@/features/realtime-voice/realtime-voice-window-owner";
import { dictationTextResult } from "../../../../../../tests/fixtures/dictation-diagnostics";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  installAsyncRequestAnimationFrame,
  installWindowApi,
} from "../../../../test/browser-globals";
import { render } from "../../../../test/dom";
import { NodexTooltipProvider as TooltipProvider } from "../../../../components/ui/tooltip";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import { ThreadComposer } from "./local-conversation-thread-composer";
import { RendererStateProvider } from "@/app-providers";
import { TestComposerScopePath } from "@/test/maitai-scope-harness";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { commandKeymapStateQueryOptions } from "@/lib/query-options";
import { createCommandKeymapState } from "../../../../../shared/command-keybindings";
import { __resetNodexToastStoreForTests } from "@/components/ui/toast";

const streamFixture = vi.hoisted(() => ({
  enabled: false,
  failFinish: false,
  text: "",
  onTranscript: null as ((text: string, segment?: { id: number; text: string }) => void) | null,
}));
vi.mock("@/features/dictation/dictation-streaming-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/features/dictation/dictation-streaming-client")>();
  return {
    ...original,
    createBrowserDictationStreamingPort: (
      ...args: Parameters<typeof original.createBrowserDictationStreamingPort>
    ) => {
      if (!streamFixture.enabled) return original.createBrowserDictationStreamingPort(...args);
      return {
        prepare: async (
          _sessionId: string,
          options?: {
            onTranscript?: (text: string, segment?: { id: number; text: string }) => void;
          },
        ) => {
          streamFixture.onTranscript = options?.onTranscript ?? null;
          let id = 0;
          return {
            start: async () => {},
            stopAndFlush: async () => {},
            finish: async () => {
              if (streamFixture.failFinish) throw new Error("stream interrupted");
              return streamFixture.text;
            },
            split: () => ++id,
            hasBoundaries: () => id > 0,
            recover: async () => streamFixture.text,
            abort: () => {},
          };
        },
      };
    },
  };
});

class MockMediaRecorder {
  public mimeType = "audio/webm";
  public state: "inactive" | "recording" = "inactive";
  public ondataavailable: ((event: BlobEvent) => void) | null = null;
  public onstop: (() => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["audio-bytes"], { type: "audio/webm" }),
    } as BlobEvent);
    this.onstop?.();
    const dataEvent = { data: new Blob(["audio-bytes"], { type: "audio/webm" }) } as BlobEvent;
    for (const listener of this.listeners.get("dataavailable") ?? []) listener(dataEvent);
    for (const listener of this.listeners.get("stop") ?? []) listener(new Event("stop"));
  }
}

class MockAudioContext {
  sampleRate = 48_000;
  audioWorklet = {
    addModule: async () => {
      throw new Error("Streaming worklets are outside this composer fixture");
    },
  };

  createMediaStreamSource() {
    return {
      connect: () => {},
      disconnect: () => {},
    };
  }

  createAnalyser() {
    return {
      fftSize: 256,
      frequencyBinCount: 128,
      getFloatTimeDomainData: (values: Float32Array) => values.fill(0),
      getByteTimeDomainData: (values: Uint8Array) => values.fill(128),
      disconnect: () => {},
    };
  }

  createScriptProcessor() {
    return {
      onaudioprocess: null,
      connect: () => {},
      disconnect: () => {},
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function buildModel(overrides?: Partial<ThreadFooterModel>): ThreadFooterModel {
  return {
    connectionStatus: "connected",
    workspaceSearchContext: {
      hostId: "local",
      roots: ["/tmp/project"],
      skillRoots: ["/tmp/project"],
    },
    projectId: "project_1",
    hostId: "local",
    projectWorkspacePath: "/tmp/project",
    threadId: "thread_1",
    cwd: "/tmp/project",
    account: {
      status: "ready",
      account: {
        type: "chatgpt",
        email: "asc@example.com",
        planType: "Pro",
      },
      requiresOpenAiAuth: false,
      pendingLogin: null,
      rateLimits: null,
    },
    conversation: {
      threadId: "thread_1",
      projectId: "project_1",
      source: null,
      threadName: "Thread",
      threadPreview: "Preview",
      modelProvider: "openai",
      cwd: "/tmp/project",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      linkedAt: "2026-04-06T00:00:00.000Z",
      resumeState: "resumed",
      turns: [],
      requests: [],
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
      pendingSteers: [],
      backgroundTerminalRows: [],
      capabilityFlags: {
        canEditUserTurns: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    },
    resumeState: "resumed",
    activeTurn: null,
    isThreadRunning: false,
    isNewThreadTab: false,
    isCloudNewThreadTarget: false,
    newThreadTarget: null,
    availableModels: [],
    collaborationModes: [],
    selectedCollaborationMode: "default",
    selectedModel: "gpt-5.3-codex",
    modelPickerShortcut: {
      label: "Ctrl+Shift+M",
      ariaKeyShortcuts: "Control+Shift+M",
    },
    selectedReasoningEffort: "high",
    reasoningEffortOptions: [],
    isQueueingEnabled: false,
    composerEnterBehavior: "enter",
    composerIntent: null,
    dictation: {
      isEnabled: true,
      authMethod: "chatgpt",
      shortcutLabel: "Ctrl+M",
      capabilities: {
        composer: true,
        global: true,
        history: true,
        streaming: "available",
        semanticCleanup: false,
        sounds: false,
        voiceDictionary: false,
        microphoneOwner: "none",
        auth: "chatgpt",
      },
    },
    body: {
      threadId: "thread_1",
      turnCount: 1,
      isThreadRunning: false,
      activeTurnId: null,
      latestTurnId: "turn_1",
      emptyState: { type: "none" },
      showThreadStartProgressPanel: false,
    },
    composerShell: {
      activeRequest: null,
      backgroundRequest: null,
      pendingSteerRows: [],
      queuedFollowUpRows: [],
      backgroundAgentRows: [],
      backgroundTerminalRows: [],
      showRequestCards: false,
      showComposer: true,
    },
    ...overrides,
  };
}

function buildActions(overrides?: Partial<ThreadStageActions>): ThreadStageActions {
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},
    onQueueingEnabledChange: () => {},
    onSendPrompt: async () => {},
    onSteerPrompt: async () => {},
    onInterruptTurn: async () => {},
    onRespondUserInput: async () => {},
    onRespondMcpElicitation: async () => {},
    onResolvePlanImplementationRequest: async () => {},
    onEnqueueQueuedFollowUp: async () => {},
    onSendCapturedFollowUp: async () => {},
    onRemoveQueuedFollowUp: async () => {},
    onReorderQueuedFollowUps: async () => {},
    onSendQueuedFollowUpNow: async () => {},
    onEditQueuedFollowUp: async () => {},
    onEditUserTurn: async () => {},
    onForkFromTurn: async () => {},
    onUnarchiveThread: async () => {},
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: async () => {},
    ...overrides,
  };
}

function OptionalVoiceProvider({
  owner,
  children,
}: {
  owner?: RealtimeVoiceWindowOwner;
  children: ReactNode;
}) {
  return owner ? (
    <RealtimeVoiceWindowProvider owner={owner}>{children}</RealtimeVoiceWindowProvider>
  ) : (
    children
  );
}
const makeVoice = () => {
  const grant: CodexRealtimeVoiceGrant = {
    hostId: "local",
    threadId: "thread_1",
    claimId: "019a1240-1000-7000-8000-000000000001",
    realtimeSessionId: "019a1240-1000-7000-8000-000000000002",
    microphoneInputDeviceId: null,
    builtInMicrophoneLabelHint: null,
    bufferInputWhileConnecting: true,
  };
  let receive: ((event: CodexRealtimeVoiceEvent) => void) | null = null;
  const media: RealtimeVoiceMedia = {
    acceptAnswer: vi.fn(async () => {}),
    setMicrophoneMuted: vi.fn(),
    setOutputMuted: vi.fn(),
    releaseInput: vi.fn(),
    refreshInput: vi.fn(async () => {}),
    readInputStream: () => null,
    readOutputStream: () => null,
    stop: vi.fn(async () => {}),
  };
  const client: RealtimeVoiceClient = {
    read: vi.fn(async () => ({ available: true, session: null })),
    prepare: vi.fn(async () => grant),
    start: vi.fn(async () => {}),
    reportMedia: vi.fn(async () => {}),
    setMuted: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    release: vi.fn(async () => true),
    appendText: vi.fn(async () => {}),
    appendSpeech: vi.fn(async () => {}),
    injectContext: vi.fn(async () => {}),
    subscribe: (listener) => {
      receive = listener;
      return () => {
        receive = null;
      };
    },
  };
  const inputs: RealtimeVoiceMediaInput[] = [];
  const owner = createRealtimeVoiceWindowOwner({
    client,
    createMedia: async (input) => {
      inputs.push(input);
      return { offerSdp: "offer", media };
    },
  });
  const emit = (event: CodexRealtimeVoiceEvent) => receive?.(event);
  const original = window.api!.invoke;
  const reads: unknown[][] = [];
  let available = true;
  installWindowApi({
    ...window.api!,
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "codex:realtime-voice:read") {
        reads.push(args);
        return { available, session: null };
      }
      return original(channel, ...args);
    },
  });
  return {
    owner,
    grant,
    media,
    client,
    inputs,
    reads,
    emit,
    setAvailable: (next: boolean) => {
      available = next;
    },
  };
};

async function renderThreadComposer(input?: {
  model?: Partial<ThreadFooterModel>;
  actions?: Partial<ThreadStageActions>;
  voiceOwner?: RealtimeVoiceWindowOwner;
}) {
  const queryClient = createTestQueryClient();
  // The composer fixture starts with loaded keyboard settings, like an active app surface.
  await queryClient.ensureQueryData(commandKeymapStateQueryOptions());
  const rendered = render(
    <TestQueryProvider client={queryClient}>
      <RendererStateProvider>
        <TestComposerScopePath>
          <TooltipProvider>
            <OptionalVoiceProvider owner={input?.voiceOwner}>
              <ThreadComposer
                model={buildModel(input?.model)}
                actions={buildActions(input?.actions)}
                errorMessage={null}
                onErrorMessage={() => {}}
              />
            </OptionalVoiceProvider>
          </TooltipProvider>
        </TestComposerScopePath>
      </RendererStateProvider>
    </TestQueryProvider>,
  );

  await act(async () => {
    await Promise.resolve();
  });

  return rendered;
}

describe("ThreadComposer dictation", () => {
  const nativeMediaRecorder = globalThis.MediaRecorder;
  const nativeAudioContext = globalThis.AudioContext;
  let transcribeCallCount = 0;
  let transcribeResult = "";
  let transcribePromise: Promise<string> | null = null;
  let transcribeFailure: Error | null = null;
  let dictationNow = 0;

  beforeEach(() => {
    streamFixture.enabled = false;
    streamFixture.failFinish = false;
    streamFixture.text = "";
    streamFixture.onTranscript = null;
    transcribeCallCount = 0;
    transcribeResult = "";
    transcribePromise = null;
    transcribeFailure = null;
    dictationNow = 1_000;
    __resetNodexToastStoreForTests();
    vi.spyOn(performance, "now").mockImplementation(() => dictationNow);
    installAsyncRequestAnimationFrame();
    document.documentElement.dataset.codexWindowType = "electron";
    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "codex:dictation:microphone-access:request") {
          return { kind: "granted", status: "granted" };
        }
        if (channel === "codex:dictation:microphone-lease:acquire") return true;
        if (channel === "codex:dictation:microphone-lease:release") return true;
        if (channel === "codex:dictation:settings:read") {
          return {
            microphoneInputDeviceId: null,
            globalShortcutNudgeDismissed: false,
            dictionary: [],
          };
        }
        if (channel === "codex-command-keymap-state") return createCommandKeymapState();
        if (channel === "codex:dictation:transcribe") {
          transcribeCallCount += 1;
          if (transcribeFailure) throw transcribeFailure;
          return dictationTextResult(await (transcribePromise ?? transcribeResult));
        }
        return null;
      },
      on: () => () => {},
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {} }],
          getAudioTracks: () => [],
        }),
      },
    });

    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: MockMediaRecorder,
    });
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      writable: true,
      value: MockAudioContext,
    });
  });

  afterEach(async () => {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    __resetNodexToastStoreForTests();
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: nativeMediaRecorder,
    });
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      writable: true,
      value: nativeAudioContext,
    });
    vi.restoreAllMocks();
  });

  test("hides dictation when dictation support is unavailable", async () => {
    const { queryByLabelText } = await renderThreadComposer({
      model: {
        dictation: {
          isEnabled: false,
          authMethod: null,
          shortcutLabel: "Ctrl+M",
          capabilities: {
            composer: false,
            global: false,
            history: true,
            streaming: "unavailable",
            semanticCleanup: false,
            sounds: false,
            voiceDictionary: false,
            microphoneOwner: "none",
            auth: "unsupported",
          },
        },
      },
    });

    expect(queryByLabelText("Dictate")).toBe(null);
  });

  test("disables the dictation button while realtime voice is active", async () => {
    const { getByLabelText } = await renderThreadComposer({
      model: {
        dictation: {
          isEnabled: true,
          authMethod: "chatgpt",
          shortcutLabel: "Ctrl+M",
          capabilities: {
            composer: true,
            global: true,
            history: true,
            streaming: "available",
            semanticCleanup: false,
            sounds: false,
            voiceDictionary: false,
            microphoneOwner: "realtime-voice",
            auth: "chatgpt",
          },
        },
      },
    });

    expect((getByLabelText("Dictate") as HTMLButtonElement).disabled).toBe(true);
  });

  test("starts on click and inserts the transcript on stop", async () => {
    transcribeResult = "transcribed text";

    const { container, getByLabelText } = await renderThreadComposer();

    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => {
      expect(Boolean(document.querySelector('[aria-label="Stop dictation"]'))).toBe(true);
    });

    await act(async () => {
      dictationNow += 260;
      fireEvent.click(getByLabelText("Stop dictation"));
      await Promise.resolve();
    });

    await waitFor(() => {
      const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']");
      expect(editor?.textContent ?? "").toBe("transcribed text");
    });
  });

  test("keeps the dictation controls stable while transcription is pending", async () => {
    let resolveTranscription: ((transcript: string) => void) | null = null;
    transcribePromise = new Promise<string>((resolve) => {
      resolveTranscription = resolve;
    });

    const { container, getByLabelText, getByRole } = await renderThreadComposer({
      model: {
        dictation: {
          ...buildModel().dictation,
          capabilities: { ...buildModel().dictation.capabilities, streaming: "unavailable" },
        },
      },
    });

    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => {
      expect(Boolean(document.querySelector('[aria-label="Stop dictation"]'))).toBe(true);
    });

    await act(async () => {
      dictationNow += 260;
      fireEvent.click(getByLabelText("Stop dictation"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByRole("status").textContent).toBe("Transcribing");
    });
    expect((getByLabelText("Cancel transcription") as HTMLButtonElement).disabled).toBe(false);
    expect((getByLabelText("Stop dictation") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Transcribe and send") as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      resolveTranscription?.("transcribed later");
      await Promise.resolve();
    });
    await waitFor(() => {
      const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']");
      expect(editor?.textContent ?? "").toBe("transcribed later");
    });
  });

  test("shows failed recovery and appends an explicit retry result without recording again", async () => {
    transcribeFailure = new Error("transcription failed");
    const openVoiceSettings = vi.fn();
    const { container, getByLabelText, getByRole } = await renderThreadComposer({
      actions: { onOpenVoiceSettings: openVoiceSettings },
    });
    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => expect(getByLabelText("Stop dictation")).toBeTruthy());
    await act(async () => {
      dictationNow += 260;
      fireEvent.click(getByLabelText("Stop dictation"));
    });
    await waitFor(() => expect(getByRole("status").textContent).toContain("Dictation stopped"));
    expect(transcribeCallCount).toBe(2);
    const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']")!;
    await act(async () => {
      transcribeFailure = null;
      transcribeResult = "Recovered words";
      fireEvent.click(getByRole("button", { name: /^Retry$/ }));
      await Promise.resolve();
    });
    await waitFor(() => expect(editor.textContent).toBe("Recovered words"));
    expect(transcribeCallCount).toBe(3);
  });

  test("stops a microphone stream that resolves after the composer unmounts", async () => {
    let resolveStream: ((stream: MediaStream) => void) | null = null;
    let stoppedTrackCount = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            resolveStream = resolve;
          }),
      },
    });

    const { getByLabelText, unmount } = await renderThreadComposer();

    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
      await Promise.resolve();
    });
    unmount();

    await act(async () => {
      resolveStream?.({
        getTracks: () => [
          {
            stop: () => {
              stoppedTrackCount += 1;
            },
          },
        ],
        getAudioTracks: () => [],
      } as unknown as MediaStream);
      await Promise.resolve();
    });

    expect(stoppedTrackCount).toBe(1);
  });

  test("uses Ctrl+M hold to start and keyup to stop with insert", async () => {
    transcribeResult = "send me";

    const { container } = await renderThreadComposer();

    await act(async () => {
      const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']");
      if (!editor) throw new Error("Expected dictation edit target");
      editor.focus();
      fireEvent.keyDown(editor, { key: "m", ctrlKey: true });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(Boolean(document.querySelector('[aria-label="Stop dictation"]'))).toBe(true);
    });

    await act(async () => {
      dictationNow += 260;
      fireEvent.keyUp(document, { key: "m", ctrlKey: true });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(transcribeCallCount).toBe(1);
    });
    await waitFor(() => {
      const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']");
      expect(editor?.textContent ?? "").toBe("send me");
    });
  });

  test("releases a hold even when keyup moves into a blocked terminal target", async () => {
    transcribeResult = "released safely";
    const { container } = await renderThreadComposer();
    const terminal = document.createElement("button");
    terminal.dataset.codexTerminal = "true";
    document.body.append(terminal);

    try {
      await act(async () => {
        const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']");
        if (!editor) throw new Error("Expected dictation edit target");
        editor.focus();
        fireEvent.keyDown(editor, { key: "m", ctrlKey: true });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(Boolean(document.querySelector('[aria-label="Stop dictation"]'))).toBe(true);
      });
      await act(async () => {
        dictationNow += 260;
        fireEvent.keyUp(terminal, { key: "m", ctrlKey: true });
        await Promise.resolve();
      });

      await waitFor(() => {
        const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']");
        expect(editor?.textContent ?? "").toBe("released safely");
      });
    } finally {
      terminal.remove();
    }
  });

  test("sends the transcript on explicit send stop mode", async () => {
    transcribeResult = "send me";

    const onSendPromptCalls: string[] = [];
    const { getByLabelText } = await renderThreadComposer({
      actions: {
        onSendPrompt: async (prompt) => {
          onSendPromptCalls.push(prompt);
        },
      },
    });

    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => {
      expect(Boolean(document.querySelector('[aria-label="Send"]'))).toBe(true);
    });

    await act(async () => {
      dictationNow += 260;
      fireEvent.click(getByLabelText("Send"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(onSendPromptCalls.length).toBe(1);
    });
    expect(onSendPromptCalls[0]).toBe("send me");
  });
  test("keeps the editor mounted and inserts streaming revisions without duplicating final text", async () => {
    streamFixture.enabled = true;
    streamFixture.text = "Hello world.";
    const { container, getByLabelText } = await renderThreadComposer();
    const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']")!;
    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => expect(streamFixture.onTranscript).not.toBeNull());
    await act(async () => {
      streamFixture.onTranscript?.("Hello", { id: 0, text: "Hello" });
      await Promise.resolve();
    });
    expect(container.querySelector("[data-codex-composer='true']")).toBe(editor);
    expect(editor.textContent).toBe("Hello");
    await act(async () => {
      streamFixture.onTranscript?.("Hello world", { id: 0, text: "Hello world" });
      dictationNow += 300;
      fireEvent.click(getByLabelText("Stop dictation"));
      await Promise.resolve();
    });
    await waitFor(() => expect(editor.textContent).toBe("Hello world."));
    expect(transcribeCallCount).toBe(0);
  });

  test("Enter finishes dictation before sending the latest transcript", async () => {
    streamFixture.enabled = true;
    streamFixture.text = "Send the final words";
    const onSendPrompt = vi.fn(async (_prompt: string) => {});
    const { container, getByLabelText } = await renderThreadComposer({ actions: { onSendPrompt } });
    const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']")!;
    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => expect(streamFixture.onTranscript).not.toBeNull());
    await act(async () => {
      streamFixture.onTranscript?.("Send", { id: 0, text: "Send" });
      await Promise.resolve();
    });
    await act(async () => {
      dictationNow += 300;
      fireEvent.keyDown(editor, { key: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt.mock.calls[0]?.[0]).toBe("Send the final words");
  });

  test("Escape removes streaming text and ignores late revisions", async () => {
    streamFixture.enabled = true;
    const { container, getByLabelText } = await renderThreadComposer();
    const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']")!;
    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => expect(streamFixture.onTranscript).not.toBeNull());
    await act(async () => {
      streamFixture.onTranscript?.("Discard this", { id: 0, text: "Discard this" });
      await Promise.resolve();
    });
    expect(editor.textContent).toBe("Discard this");
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(editor.textContent).toBe(""));
    await act(async () => {
      streamFixture.onTranscript?.("Late text", { id: 0, text: "Late text" });
      await Promise.resolve();
    });
    expect(editor.textContent).toBe("");
    expect(transcribeCallCount).toBe(0);
  });

  test("upgrades pending insertion to send without transcribing or submitting twice", async () => {
    let resolve!: (text: string) => void;
    transcribePromise = new Promise<string>((accept) => {
      resolve = accept;
    });
    const onSendPrompt = vi.fn(async (_prompt: string) => {});
    const { getByLabelText } = await renderThreadComposer({ actions: { onSendPrompt } });
    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => expect(getByLabelText("Stop dictation")).toBeTruthy());
    await act(async () => {
      dictationNow += 300;
      fireEvent.click(getByLabelText("Stop dictation"));
    });
    await waitFor(() =>
      expect((getByLabelText("Finishing dictation") as HTMLButtonElement).disabled).toBe(true),
    );
    await act(async () => {
      fireEvent.click(getByLabelText("Send"));
      resolve("Ready to send");
      await Promise.resolve();
    });
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalledTimes(1));
    expect(onSendPrompt.mock.calls[0]?.[0]).toBe("Ready to send");
    expect(transcribeCallCount).toBe(1);
  });
  test("offers segmented recovery for explicit insertion while preserving the current draft", async () => {
    streamFixture.enabled = true;
    streamFixture.failFinish = true;
    streamFixture.text = "All recovered speech";
    const onSendPrompt = vi.fn(async (_prompt: string) => {});
    const { container, getByLabelText, getByRole } = await renderThreadComposer({
      actions: { onSendPrompt },
    });
    const editor = container.querySelector<HTMLElement>("[data-codex-composer='true']")!;
    await act(async () => {
      fireEvent.click(getByLabelText("Dictate"));
    });
    await waitFor(() => expect(streamFixture.onTranscript).not.toBeNull());
    await act(async () => {
      streamFixture.onTranscript?.("Partial words", { id: 0, text: "Partial words" });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.paste(editor, {
        clipboardData: {
          files: [],
          items: [],
          getData: (type: string) => (type === "text/plain" ? " edited" : ""),
        },
      });
      dictationNow += 300;
      fireEvent.click(getByLabelText("Send"));
      await Promise.resolve();
    });
    await waitFor(() => expect(getByRole("button", { name: "Add to message" })).toBeTruthy());
    expect(editor.textContent).toBe("Partial words edited");
    expect(onSendPrompt).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Add to message" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(editor.textContent).toBe("Partial words edited All recovered speech"),
    );
    expect(onSendPrompt).not.toHaveBeenCalled();
  });
  test("ordinary Voice controls enter the real native target, mute the same media and release it before ending the claim", async () => {
    const f = makeVoice();
    const view = await renderThreadComposer({ voiceOwner: f.owner });
    const start = await view.findByRole("button", { name: "Start voice" });
    expect(f.reads[0]).toEqual([{ hostId: "local", threadId: "thread_1" }]);
    await act(async () => {
      fireEvent.click(start);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(f.client.start).toHaveBeenCalledExactlyOnceWith(f.grant.claimId, "offer"),
    );
    expect(f.owner.read().phase).toBe("starting");
    await act(async () => {
      f.inputs[0]!.onConnected();
      f.inputs[0]!.onInitialized("remote-RTC-session");
      f.emit({
        type: "snapshot",
        snapshot: {
          ...f.grant,
          phase: "active",
          microphoneMuted: false,
          outputMuted: false,
          revision: 1,
        },
      });
      await Promise.resolve();
    });
    await view.findByRole("button", { name: "End voice" });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Mute microphone" }));
      await Promise.resolve();
    });
    await view.findByRole("button", { name: "Unmute microphone" });
    expect(f.media.setMicrophoneMuted).toHaveBeenCalledExactlyOnceWith(true);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Mute voice" }));
      await Promise.resolve();
    });
    await view.findByRole("button", { name: "Unmute voice" });
    expect(f.media.setOutputMuted).toHaveBeenCalledExactlyOnceWith(true);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "End voice" }));
      await Promise.resolve();
    });
    await view.findByRole("button", { name: "Start voice" });
    expect(f.media.stop).toHaveBeenCalledTimes(1);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(f.grant.claimId);
    expect(vi.mocked(f.media.stop).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.client.release).mock.invocationCallOrder[0]!,
    );
  });
  test("unknown admission stays hidden and a live policy revision enables the real control without acquiring media", async () => {
    const f = makeVoice();
    f.setAvailable(false);
    const view = await renderThreadComposer({ voiceOwner: f.owner });
    await waitFor(() => expect(f.reads.length).toBe(1));
    expect(view.queryByRole("button", { name: "Start voice" })).toBeNull();
    expect(f.client.prepare).not.toHaveBeenCalled();
    await act(async () => {
      f.setAvailable(true);
      f.emit({ type: "availabilityChanged" });
      await Promise.resolve();
    });
    await view.findByRole("button", { name: "Start voice" });
    expect(f.client.prepare).not.toHaveBeenCalled();
    expect(f.inputs).toEqual([]);
  });
});
