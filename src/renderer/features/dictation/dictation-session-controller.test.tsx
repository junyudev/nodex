import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { useDictationSession } from "./use-dictation-session";
import { emptyDictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import { describe, expect, it, test, vi } from "vitest";
import {
  DICTATION_HISTORY_CHUNK_INTERVAL_MS,
  MAXIMUM_DICTATION_DURATION_MS,
  DictationSessionController,
  type DictationControllerPorts,
  type DictationRecorderHandle,
  type DictationStreamingAttempt,
} from "./dictation-session-controller";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const createFixture = (
  options: {
    readonly acquire?: () => Promise<MediaStream>;
    readonly requestPermission?: DictationControllerPorts["permissions"]["request"];
    readonly prepareStreaming?: DictationControllerPorts["streaming"]["prepare"];
    readonly transcribe?: DictationControllerPorts["buffered"]["transcribe"];
    readonly cleanup?: DictationControllerPorts["cleanup"]["transcript"];
    readonly onRecoveryChange?: DictationControllerPorts["onRecoveryChange"];
    readonly recordingDurationLimitMs?: DictationControllerPorts["recordingDurationLimitMs"];
  } = {},
) => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<
    number,
    {
      readonly callback: () => void;
      readonly delayMs: number;
      readonly dueAtMs: number;
    }
  >();
  let callbacks: Parameters<DictationControllerPorts["recorder"]["create"]>[1] | null = null;
  let streamingOptions: Parameters<DictationControllerPorts["streaming"]["prepare"]>[1];
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
    start: vi.fn<DictationStreamingAttempt["start"]>(async () => undefined),
    stopAndFlush: vi.fn<() => Promise<void>>(async () => undefined),
    finish: vi.fn<() => Promise<string | null>>(async () => null),
    split: vi.fn<() => number | null>(() => 1),
    hasBoundaries: vi.fn(() => false),
    recover: vi.fn<DictationStreamingAttempt["recover"]>(async () => "recovered segments"),
    abort: vi.fn(),
  };
  const transcript = {
    start: vi.fn<NonNullable<DictationControllerPorts["transcript"]>["start"]>(),
    update: vi.fn<NonNullable<DictationControllerPorts["transcript"]>["update"]>(),
    cancel: vi.fn(),
    preserve: vi.fn(),
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
    acquire: vi.fn<DictationControllerPorts["lease"]["acquire"]>(async () => true),
    release: vi.fn(async () => undefined),
  };
  const onRecordingStopped = vi.fn();
  const onRecordingStarted = vi.fn();
  const onStopRequested = vi.fn();
  const ports: DictationControllerPorts = {
    recordingDurationLimitMs:
      options.recordingDurationLimitMs === undefined
        ? MAXIMUM_DICTATION_DURATION_MS
        : options.recordingDurationLimitMs,
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
      prepare:
        options.prepareStreaming ??
        (async (_sessionId, nextOptions) => {
          streamingOptions = nextOptions;
          return streamingAttempt;
        }),
    },
    transcript,
    onRecoveryChange: options.onRecoveryChange,
    buffered,
    cleanup,
    history,
    completion,
    onRecordingStopped,
    onRecordingStarted,
    onStopRequested,
    clock: {
      now: () => now,
      wallNow: () => now,
      setTimeout: (callback, delayMs) => {
        nextTimer += 1;
        timers.set(nextTimer, { callback, delayMs, dueAtMs: now + delayMs });
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
    onRecordingStopped,
    onRecordingStarted,
    onStopRequested,
    recorder,
    timerCallback: (delayMs: number) => {
      const timer = [...timers.values()].find((value) => value.delayMs === delayMs);
      if (!timer) throw new Error(`Missing ${delayMs}ms timer`);
      return timer.callback;
    },
    advanceTo: (value: number) => {
      for (;;) {
        const timer = [...timers.entries()]
          .filter(([, timer]) => timer.dueAtMs <= value)
          .sort(([, left], [, right]) => left.dueAtMs - right.dueAtMs)[0];
        if (!timer) break;
        now = timer[1].dueAtMs;
        timers.delete(timer[0]);
        timer[1].callback();
      }
      now = value;
    },
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
    transcript,
    receiveTranscript: (text: string, segment?: { id: number; text: string }) =>
      streamingOptions?.onTranscript?.(text, segment),
    stopRecorder: () => callbacks?.onStop(),
    emitChunk: (chunk: Blob) => callbacks?.onChunk(chunk),
  };
};

describe("DictationSessionController", () => {
  it("relinquishes the actual captured tracks before releasing its Main microphone lease", async () => {
    const fixture = createFixture();
    await fixture.controller.start({ surface: "composer", gesture: "click" });
    const relinquish = fixture.lease.acquire.mock.calls[0]?.[2];
    expect(relinquish).toBeTypeOf("function");
    fixture.lease.release.mockImplementation(async () => {
      expect(fixture.track.stop).toHaveBeenCalledOnce();
      expect(fixture.recorder.dispose).toHaveBeenCalledOnce();
    });
    relinquish?.();
    await flush();
    expect(fixture.controller.getSnapshot().kind).toBe("idle");
    expect(fixture.lease.release).toHaveBeenCalledOnce();
    expect(fixture.completion.apply).not.toHaveBeenCalled();
  });

  it("relinquishes permission-stage capture and stops a later microphone without reviving it", async () => {
    let resolveStream: (stream: MediaStream) => void = () => undefined;
    const stream = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const fixture = createFixture({ acquire: () => stream });
    const starting = fixture.controller.start({ surface: "composer", gesture: "click" });
    await flush();
    fixture.lease.acquire.mock.calls[0]?.[2]();
    await flush();
    expect(fixture.controller.getSnapshot().kind).toBe("idle");
    resolveStream(fixture.stream);
    await starting;
    expect(fixture.track.stop).toHaveBeenCalledOnce();
    expect(fixture.recorder.start).not.toHaveBeenCalled();
    expect(fixture.lease.release).toHaveBeenCalledOnce();
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
    expect(fixture.controller.getSnapshot()).toMatchObject({
      kind: "transcribing",
      action: "send",
    });
    resolveTranscript("send me");
    await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));

    expect(fixture.recorder.stop).toHaveBeenCalledOnce();
    expect(fixture.completion.apply).toHaveBeenCalledOnce();
    expect(fixture.completion.apply).toHaveBeenCalledWith(
      expect.objectContaining({ action: "send" }),
    );
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

test("flushes the streaming tail before stopping microphone tracks", async () => {
  const fixture = createFixture();
  let completeFlush!: () => void;
  fixture.streamingAttempt.stopAndFlush.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        completeFlush = resolve;
      }),
  );
  fixture.streamingAttempt.finish.mockResolvedValue("flushed text");
  await fixture.controller.start({ surface: "composer", gesture: "hold" });
  fixture.setNow(1000);
  fixture.controller.stop("insert");
  expect(fixture.track.stop).not.toHaveBeenCalled();
  expect(fixture.onRecordingStopped).not.toHaveBeenCalled();
  completeFlush();
  await vi.waitFor(() => expect(fixture.completion.apply).toHaveBeenCalledOnce());
  expect(fixture.track.stop).toHaveBeenCalledOnce();
  expect(fixture.onRecordingStopped).toHaveBeenCalledExactlyOnceWith("session-1");
});

it("starts segment ownership, forwards revisions and rejects late updates after cancellation", async () => {
  const fixture = createFixture();
  await fixture.controller.start({ surface: "composer", gesture: "click" });
  const split = fixture.transcript.start.mock.calls[0]?.[0];
  expect(split?.()).toBe(1);
  fixture.receiveTranscript("hello", { id: 0, text: "hello" });
  expect(fixture.transcript.update).toHaveBeenCalledExactlyOnceWith("hello", {
    id: 0,
    text: "hello",
  });
  fixture.controller.cancel();
  fixture.receiveTranscript("late", { id: 0, text: "late" });
  expect(fixture.transcript.update).toHaveBeenCalledOnce();
  expect(fixture.transcript.cancel).toHaveBeenCalledOnce();
  expect(split?.()).toBeNull();
});

it("reuses segmented recovery on retry rather than uploading the full recording", async () => {
  const fixture = createFixture();
  fixture.streamingAttempt.hasBoundaries.mockReturnValue(true);
  fixture.streamingAttempt.recover.mockRejectedValueOnce(new Error("temporary recovery failure"));
  fixture.streamingAttempt.recover.mockImplementationOnce(
    async (transcribe) =>
      `existing segment ${await transcribe(new Blob(["remaining PCM"], { type: "audio/wav" }))}`,
  );
  await fixture.controller.start({ surface: "composer", gesture: "click" });
  fixture.setNow(300);
  fixture.controller.stop("insert");
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("retryable-error"));
  expect(fixture.buffered.transcribe).not.toHaveBeenCalled();
  await fixture.controller.retry();
  expect(fixture.streamingAttempt.recover).toHaveBeenCalledTimes(2);
  expect(fixture.streamingAttempt.finish).toHaveBeenCalledOnce();
  expect(fixture.buffered.transcribe.mock.calls[0]?.[0].type).toBe("audio/wav");
  expect(fixture.completion.apply).toHaveBeenCalledWith(
    expect.objectContaining({ transcript: "existing segment hello world" }),
  );
});

it("holds activation through async insertion and upgrades a pending insert to one empty send", async () => {
  const fixture = createFixture();
  const insertion = deferred<void>();
  fixture.completion.apply.mockImplementationOnce(() => insertion.promise);
  await fixture.controller.start({ surface: "composer", gesture: "click" });
  fixture.setNow(300);
  fixture.controller.stop("insert");
  await vi.waitFor(() => expect(fixture.completion.apply).toHaveBeenCalledOnce());
  expect(fixture.lease.release).not.toHaveBeenCalled();
  fixture.controller.stop("send");
  fixture.controller.stop("send");
  insertion.resolve();
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));
  expect(
    fixture.completion.apply.mock.calls.map(([input]) => [input.action, input.transcript]),
  ).toEqual([
    ["insert", "hello world"],
    ["send", ""],
  ]);
  expect(fixture.lease.release).toHaveBeenCalledOnce();
});

it("preserves provisional text and offers automatically recovered audio without inserting it", async () => {
  const recovery = vi.fn();
  let attempts = 0;
  const fixture = createFixture({
    onRecoveryChange: recovery,
    transcribe: async () => {
      if (++attempts === 1) throw new Error("temporary service failure");
      return "recovered speech";
    },
  });
  await fixture.controller.start({ surface: "composer", gesture: "click" });
  fixture.receiveTranscript("partial", { id: 0, text: "partial" });
  fixture.setNow(300);
  fixture.controller.stop("send");
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));
  expect(fixture.buffered.transcribe).toHaveBeenCalledTimes(2);
  expect(fixture.transcript.preserve).toHaveBeenCalledOnce();
  expect(fixture.transcript.cancel).not.toHaveBeenCalled();
  expect(recovery).toHaveBeenLastCalledWith({
    recordingId: "session-1",
    saveState: "saved",
    phase: "recovered",
    text: "recovered speech",
  });
  expect(fixture.completion.apply).not.toHaveBeenCalled();
});

it("recovers an unexpected recorder stop while retaining the edited draft", async () => {
  const recovery = vi.fn();
  const fixture = createFixture({ onRecoveryChange: recovery });
  await fixture.controller.start({ surface: "composer", gesture: "click" });
  fixture.setNow(300);
  fixture.emitChunk(new Blob(["interrupted audio"], { type: "audio/webm" }));
  fixture.stopRecorder();
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));
  expect(fixture.streamingAttempt.abort).toHaveBeenCalledOnce();
  expect(fixture.transcript.preserve).toHaveBeenCalledOnce();
  expect(recovery).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: "recovered", text: "hello world" }),
  );
  expect(fixture.completion.apply).not.toHaveBeenCalled();
});

it("confirms a global hold after 100ms from activation without extending its actual audio duration", async () => {
  const fixture = createFixture();
  await fixture.controller.start({ surface: "global", gesture: "hold", activationStartedAtMs: 0 });
  expect(fixture.onRecordingStarted).not.toHaveBeenCalled();
  expect(fixture.history.create).not.toHaveBeenCalled();
  fixture.emitChunk(new Blob(["early PCM"], { type: "audio/webm" }));
  fixture.setNow(100);
  fixture.runTimer(100);
  await flush();
  expect(fixture.onRecordingStarted).toHaveBeenCalledOnce();
  expect(fixture.history.append).toHaveBeenCalledOnce();
  await expect(fixture.streamingAttempt.start.mock.calls[0]?.[1]).resolves.toBe(true);
  fixture.setNow(249);
  fixture.controller.stop("insert");
  expect(fixture.onStopRequested).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));
  expect(fixture.buffered.transcribe).not.toHaveBeenCalled();
  expect(fixture.onRecordingStopped).toHaveBeenCalledOnce();
});

it("cancels an unconfirmed hold without admitting PCM or creating history", async () => {
  const fixture = createFixture();
  await fixture.controller.start({ surface: "global", gesture: "hold", activationStartedAtMs: 0 });
  fixture.setNow(50);
  fixture.controller.stop("insert");
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("idle"));
  await expect(fixture.streamingAttempt.start.mock.calls[0]?.[1]).resolves.toBe(false);
  expect(fixture.history.create).not.toHaveBeenCalled();
  expect(fixture.onRecordingStarted).not.toHaveBeenCalled();
  expect(fixture.onRecordingStopped).not.toHaveBeenCalled();
});

it("invalidates an optional language lookup when activation is cancelled", async () => {
  const language = deferred<string>();
  const fixture = createFixture();
  const starting = fixture.controller.start({
    surface: "composer",
    gesture: "hold",
    getLanguage: () => language.promise,
  });
  await flush();
  expect(fixture.controller.getSnapshot().kind).toBe("requesting-permission");
  fixture.controller.stop("insert");
  language.resolve("en");
  await starting;
  expect(fixture.acquire).not.toHaveBeenCalled();
  expect(fixture.recorder.start).not.toHaveBeenCalled();
  expect(fixture.lease.release).toHaveBeenCalledOnce();
});

it("saves an explicit recovery retry after detach without appending into a closed Composer", async () => {
  const pending = deferred<string>();
  const recovery = vi.fn();
  let attempts = 0;
  const fixture = createFixture({
    onRecoveryChange: recovery,
    transcribe: async () => {
      if (++attempts < 3) throw new Error("service unavailable");
      return pending.promise;
    },
  });
  await fixture.controller.start({ surface: "composer", gesture: "click" });
  fixture.setNow(300);
  fixture.controller.stop("send");
  await vi.waitFor(() => expect(fixture.controller.getSnapshot().kind).toBe("retryable-error"));
  const retrying = fixture.controller.retry();
  await vi.waitFor(() => expect(fixture.buffered.transcribe).toHaveBeenCalledTimes(3));
  fixture.controller.detach();
  pending.resolve("recovered after leaving");
  await retrying;
  expect(fixture.controller.getSnapshot().kind).toBe("idle");
  expect(fixture.history.finalize).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "completed", transcript: "recovered after leaving" }),
  );
  expect(fixture.completion.apply).not.toHaveBeenCalled();
});
