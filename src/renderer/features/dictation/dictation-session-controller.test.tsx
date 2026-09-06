import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { useDictationSession } from "./use-dictation-session";
import { emptyDictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import { describe, expect, it, vi } from "vitest";
import {
  DICTATION_HISTORY_CHUNK_INTERVAL_MS,
  DictationSessionController,
  type DictationControllerPorts,
  type DictationRecorderHandle,
} from "./dictation-session-controller";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const createFixture = (
  options: {
    readonly acquire?: () => Promise<MediaStream>;
    readonly requestPermission?: DictationControllerPorts["permissions"]["request"];
    readonly prepareStreaming?: DictationControllerPorts["streaming"]["prepare"];
    readonly transcribe?: DictationControllerPorts["buffered"]["transcribe"];
    readonly cleanup?: DictationControllerPorts["cleanup"]["transcript"];
  } = {},
) => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  let callbacks: Parameters<DictationControllerPorts["recorder"]["create"]>[1] | null = null;
  const track = { stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream;
  const recorder: DictationRecorderHandle = {
    mimeType: "audio/webm",
    state: "inactive",
    start: vi.fn(() => {
      Object.defineProperty(recorder, "state", { configurable: true, value: "recording" });
    }),
    stop: vi.fn(() => {
      Object.defineProperty(recorder, "state", { configurable: true, value: "inactive" });
      callbacks?.onChunk(new Blob(["audio"], { type: "audio/webm" }));
      callbacks?.onStop();
    }),
    dispose: vi.fn(),
  };
  const streamingAttempt = {
    diagnostics: vi.fn(emptyDictationStreamDiagnostics),
    start: vi.fn(async () => undefined),
    finish: vi.fn<() => Promise<string | null>>(async () => null),
    abort: vi.fn(),
  };
  const history = {
    diagnostics: vi.fn<DictationControllerPorts["history"]["diagnostics"]>(async () => undefined),
    create: vi.fn(async () => undefined),
    append: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
  };
  const completion = {
    apply: vi.fn<DictationControllerPorts["completion"]["apply"]>(async () => undefined),
  };
  const buffered = {
    transcribe: vi.fn(options.transcribe ?? (async () => "hello world")),
  };
  const cleanup = {
    enabled: true,
    transcript: vi.fn(options.cleanup ?? (async (transcript: string) => transcript)),
  };
  const acquire = vi.fn(options.acquire ?? (async () => stream));
  const lease = {
    acquire: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
  const ports: DictationControllerPorts = {
    lease,
    permissions: {
      request: options.requestPermission ?? (async () => ({ kind: "granted", status: "granted" })),
    },
    devices: { acquire },
    recorder: {
      create: (_stream, nextCallbacks) => {
        callbacks = nextCallbacks;
        return recorder;
      },
    },
    waveform: { start: () => ({ dispose: vi.fn() }) },
    streaming: {
      prepare: options.prepareStreaming ?? (async () => streamingAttempt),
    },
    buffered,
    cleanup,
    history,
    completion,
    clock: {
      now: () => now,
      setTimeout: (callback, delayMs) => {
        nextTimer += 1;
        timers.set(nextTimer, { callback, delayMs });
        return nextTimer as never;
      },
      clearTimeout: (timer) => {
        timers.delete(timer as never as number);
      },
    },
    createId: () => "session-1",
  };
  const controller = new DictationSessionController(ports);
  return {
    acquire,
    buffered,
    cleanup,
    completion,
    controller,
    history,
    lease,
    recorder,
    runTimer: (delayMs: number) => {
      const timer = [...timers.entries()].find(([, value]) => value.delayMs === delayMs);
      if (!timer) throw new Error(`Missing ${delayMs}ms timer`);
      timers.delete(timer[0]);
      timer[1].callback();
    },
    setNow: (value: number) => {
      now = value;
    },
    stream,
    track,
    streamingAttempt,
  };
};

describe("DictationSessionController", () => {
  it("stops a late microphone stream after release during acquisition", async () => {
    let resolveStream: (stream: MediaStream) => void = () => undefined;
    const acquisition = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const fixture = createFixture({ acquire: async () => await acquisition });

    const starting = fixture.controller.start({ surface: "composer", gesture: "hold" });
    await flush();
    expect(fixture.controller.getSnapshot().kind).toBe("acquiring-stream");
    fixture.controller.stop("insert");
    expect(fixture.controller.getSnapshot().kind).toBe("idle");
    resolveStream(fixture.stream);
    await starting;

    expect(fixture.track.stop).toHaveBeenCalledOnce();
    expect(fixture.recorder.start).not.toHaveBeenCalled();
  });

  it("records in five-second chunks and falls back to the complete Blob when streaming fails", async () => {
    const fixture = createFixture({
      prepareStreaming: async () => {
        throw new Error("stream unavailable");
      },
    });
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    fixture.setNow(300);
    fixture.controller.stop("send");
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));

    expect(fixture.recorder.start).toHaveBeenCalledWith(DICTATION_HISTORY_CHUNK_INTERVAL_MS);
    expect(fixture.buffered.transcribe).toHaveBeenCalledOnce();
    const audio = fixture.buffered.transcribe.mock.calls[0]?.[0];
    expect(audio).toBeInstanceOf(Blob);
    expect(audio?.size).toBeGreaterThan(0);
    expect(fixture.history.append).toHaveBeenCalledOnce();
    expect(fixture.history.finalize).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "completed", transcript: "hello world" }),
    );
    expect(fixture.completion.apply).toHaveBeenCalledWith({
      sessionId: "session-1",
      signal: expect.any(AbortSignal),
      action: "send",
      transcript: "hello world",
    });
  });

  it("retries transcription with the exact retained audio object", async () => {
    let attempt = 0;
    const fixture = createFixture({
      transcribe: async () => {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error("temporary"), { status: 503 });
        return "recovered";
      },
    });
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    fixture.setNow(300);
    fixture.controller.stop("insert");
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("retryable-error"));
    const retained = fixture.buffered.transcribe.mock.calls[0]?.[0];

    await fixture.controller.retry();

    expect(fixture.buffered.transcribe.mock.calls[1]?.[0]).toBe(retained);
    expect(fixture.completion.apply).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "recovered" }),
    );
    expect(fixture.controller.getSnapshot().kind).toBe("idle");
  });

  it("applies semantic cleanup after either transport and fails open on cleanup errors", async () => {
    const cleaned = createFixture({ cleanup: async () => "Nodex" });
    await cleaned.controller.start({ surface: "composer", gesture: "click" });
    cleaned.setNow(300);
    cleaned.controller.stop("insert");
    await vi.waitFor(() => expect(cleaned.controller.getSnapshot().kind).toBe("idle"));
    expect(cleaned.cleanup.transcript).toHaveBeenCalledWith(
      "hello world",
      expect.any(AbortSignal),
      "session-1",
      expect.any(Function),
    );
    expect(cleaned.completion.apply).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "Nodex" }),
    );

    const failOpen = createFixture({
      cleanup: async () => {
        throw new Error("cleanup unavailable");
      },
    });
    await failOpen.controller.start({ surface: "composer", gesture: "click" });
    failOpen.setNow(300);
    failOpen.controller.stop("insert");
    await vi.waitFor(() => expect(failOpen.controller.getSnapshot().kind).toBe("idle"));
    expect(failOpen.completion.apply).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "hello world" }),
    );
  });

  it("discards 249ms locally but transcribes the 250ms boundary", async () => {
    const tooShort = createFixture();
    await tooShort.controller.start({ surface: "composer", gesture: "click" });
    tooShort.setNow(249);
    tooShort.controller.stop("insert");
    await vi.waitFor(() => expect(tooShort.controller.getSnapshot().kind).toBe("idle"));
    expect(tooShort.buffered.transcribe).not.toHaveBeenCalled();
    expect(tooShort.history.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", durationMs: 249 }),
    );
    expect(tooShort.streamingAttempt.abort).toHaveBeenCalledOnce();
    expect(tooShort.lease.release).toHaveBeenCalledWith("session-1");

    const accepted = createFixture();
    await accepted.controller.start({ surface: "composer", gesture: "click" });
    accepted.setNow(250);
    accepted.controller.stop("insert");
    await vi.waitFor(() => expect(accepted.controller.getSnapshot().kind).toBe("idle"));
    expect(accepted.buffered.transcribe).toHaveBeenCalledOnce();
  });

  it("does not apply a transcript after cancellation while history is finalizing", async () => {
    let resolveFinalize: (value: undefined) => void = () => undefined;
    const fixture = createFixture();
    fixture.history.finalize.mockImplementationOnce(
      async () => await new Promise<undefined>((resolve) => (resolveFinalize = resolve)),
    );
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    fixture.setNow(300);
    fixture.controller.stop("insert");
    await vi.waitFor(() => expect(fixture.history.finalize).toHaveBeenCalledOnce());

    fixture.controller.cancel();
    resolveFinalize(undefined);
    await flush();

    expect(fixture.completion.apply).not.toHaveBeenCalled();
    expect(fixture.controller.getSnapshot().kind).toBe("idle");
  });

  it("uses a streaming final without sending a buffered request", async () => {
    const fixture = createFixture();
    fixture.streamingAttempt.finish.mockResolvedValue("streaming final");
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    fixture.setNow(300);
    fixture.controller.stop("insert");
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));

    expect(fixture.buffered.transcribe).not.toHaveBeenCalled();
    expect(fixture.completion.apply).toHaveBeenCalledOnce();
    expect(fixture.completion.apply).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "streaming final" }),
    );
  });

  it("stops once at 595 seconds", async () => {
    const fixture = createFixture();
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    fixture.setNow(595_000);
    fixture.runTimer(595_000);
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));

    expect(fixture.recorder.stop).toHaveBeenCalledOnce();
    expect(fixture.completion.apply).toHaveBeenCalledOnce();
  });

  it("upgrades insert to send during one idempotent finalization", async () => {
    let resolveTranscript: (value: string) => void = () => undefined;
    const fixture = createFixture({
      transcribe: async () =>
        await new Promise((resolve) => {
          resolveTranscript = resolve;
        }),
    });
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    fixture.setNow(300);
    fixture.controller.stop("insert");
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("transcribing"));
    await vi.waitFor(() => expect(fixture.buffered.transcribe).toHaveBeenCalledOnce());
    fixture.controller.stop("send");
    fixture.controller.stop("send");
    resolveTranscript("send me");
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));

    expect(fixture.recorder.stop).toHaveBeenCalledOnce();
    expect(fixture.completion.apply).toHaveBeenCalledOnce();
    expect(fixture.completion.apply).toHaveBeenCalledWith(
      expect.objectContaining({ action: "send" }),
    );
  });

  it("aborts transcription and ignores its late result", async () => {
    let resolveTranscript: (value: string) => void = () => undefined;
    const fixture = createFixture({
      transcribe: async () =>
        await new Promise((resolve) => {
          resolveTranscript = resolve;
        }),
    });
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    fixture.setNow(300);
    fixture.controller.stop("insert");
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("transcribing"));
    await vi.waitFor(() => expect(fixture.buffered.transcribe).toHaveBeenCalledOnce());
    fixture.controller.cancel();
    resolveTranscript("too late");
    await flush();

    expect(fixture.controller.getSnapshot().kind).toBe("idle");
    expect(fixture.completion.apply).not.toHaveBeenCalled();
    expect(fixture.track.stop).toHaveBeenCalledOnce();
  });

  it("does not acquire a device after permission is denied", async () => {
    const fixture = createFixture({
      requestPermission: async () => ({
        kind: "blocked",
        status: "denied",
        restartRequired: true,
      }),
    });
    await fixture.controller.start({ surface: "composer", gesture: "click" });

    expect(fixture.acquire).not.toHaveBeenCalled();
    expect(fixture.controller.getSnapshot()).toMatchObject({
      kind: "retryable-error",
      canRetryRecording: false,
      error: { kind: "microphone-permission-denied" },
    });
  });
});

it("records the actual streaming result, skips cleanup, and freezes recording duration at stop", async () => {
  const fixture = createFixture();
  fixture.cleanup.enabled = false;
  fixture.streamingAttempt.finish.mockImplementation(async () => {
    fixture.setNow(400);
    return "streamed";
  });
  fixture.streamingAttempt.diagnostics.mockReturnValue({
    ...emptyDictationStreamDiagnostics(),
    attempted: true,
    opened: true,
    started: true,
    finalReceived: true,
    sentAudioFrames: 2,
    sentAudioBytes: 512,
  });
  fixture.history.finalize.mockImplementation(async () => {
    fixture.setNow(450);
  });
  fixture.completion.apply.mockImplementation(async () => {
    fixture.setNow(500);
  });
  await fixture.controller.start({ surface: "composer", gesture: "click" });
  fixture.setNow(300);
  fixture.controller.stop("insert");
  await vi.waitFor(() => expect(fixture.history.diagnostics).toHaveBeenCalledOnce());
  expect(fixture.buffered.transcribe).not.toHaveBeenCalled();
  expect(fixture.cleanup.transcript).not.toHaveBeenCalled();
  expect(fixture.history.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ durationMs: 300 }),
  );
  expect(fixture.history.diagnostics.mock.calls[0]?.[1]).toMatchObject({
    transport: "websocket",
    stopToTextMs: 200,
    stopToCompletionMs: 200,
    phases: expect.arrayContaining([
      { stage: "cleanup", offsetMs: 400, durationMs: 0, outcome: "skipped" },
    ]),
    streaming: { attempted: true, opened: true, started: true, finalReceived: true },
  });
});

it("retries delivery with the saved transcript without retranscribing or re-finalizing audio", async () => {
  const fixture = createFixture();
  fixture.completion.apply.mockImplementationOnce(async () => {
    throw new Error("paste failed");
  });
  await fixture.controller.start({ surface: "global", gesture: "hold" });
  fixture.setNow(300);
  fixture.controller.stop("insert");
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("retryable-error"));
  fixture.setNow(2_000);
  fixture.completion.apply.mockImplementation(async () => {
    fixture.setNow(2_850);
    return { clipboardRestoreMs: 700 };
  });
  await fixture.controller.retry();
  await vi.waitFor(() => expect(fixture.history.diagnostics).toHaveBeenCalledTimes(2));
  expect(fixture.buffered.transcribe).toHaveBeenCalledOnce();
  expect(fixture.cleanup.transcript).toHaveBeenCalledOnce();
  expect(fixture.history.finalize).toHaveBeenCalledOnce();
  expect(fixture.history.diagnostics.mock.calls[1]?.[1]).toMatchObject({
    attempt: 2,
    source: "retry",
    transport: "retained",
    outcome: "completed",
    stopToTextMs: 150,
    stopToCompletionMs: 850,
    clipboardRestoreMs: 700,
    requests: [],
  });
});

describe("useDictationSession", () => {
  it("records and delivers after Strict Mode effect replay, then releases capture on unmount", async () => {
    const fixture = createFixture();
    const { result, unmount } = renderHook(() => useDictationSession(fixture.controller), {
      wrapper: StrictMode,
    });
    await act(async () => {
      await fixture.controller.start({ surface: "global", gesture: "toggle" });
    });
    expect(result.current.kind).toBe("recording");
    expect(fixture.recorder.start).toHaveBeenCalledOnce();
    fixture.setNow(1000);
    await act(async () => {
      fixture.controller.stop("insert");
      await flush();
    });
    await waitFor(() => expect(fixture.completion.apply).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.kind).toBe("idle"));
    await act(async () => {
      await fixture.controller.start({ surface: "global", gesture: "toggle" });
    });
    fixture.track.stop.mockClear();
    fixture.lease.release.mockClear();
    await act(async () => {
      unmount();
      await flush();
    });
    expect(fixture.track.stop).toHaveBeenCalledOnce();
    expect(fixture.lease.release).toHaveBeenCalledOnce();
    expect(fixture.controller.getSnapshot().kind).toBe("idle");
  });
});
