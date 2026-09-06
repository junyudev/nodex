import { describe, expect, test } from "vite-plus/test";
import {
  DICTATION_STREAM_FINISH_TIMEOUT_MS,
  DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES,
  DICTATION_STREAM_START_TIMEOUT_MS,
  type DictationStreamingClientMessage,
  type DictationStreamingConnectInfo,
  type DictationStreamingHostMessage,
  type DictationStreamingPort,
} from "../../shared/dictation-streaming";
import {
  DictationStreamingSessionService,
  type DictationStreamingClock,
  type DictationStreamingSessionServiceDependencies,
  type DictationStreamingSocket,
  type DictationStreamingSocketClose,
  type DictationStreamingSocketHandlers,
} from "./dictation-streaming-session-service";

class ManualClock implements DictationStreamingClock {
  time = 0;
  now = (): number => this.time;
  readonly timers: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];

  scheduleTimeout(callback: () => void, delayMs: number): () => void {
    const timer = { callback, delayMs, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  fire(delayMs: number): void {
    const timer = this.timers.find((candidate) => {
      return !candidate.cancelled && candidate.delayMs === delayMs;
    });
    if (timer === undefined) throw new Error(`No active ${delayMs}ms timer.`);
    timer.cancelled = true;
    timer.callback();
  }

  hasActive(delayMs: number): boolean {
    return this.timers.some((timer) => !timer.cancelled && timer.delayMs === delayMs);
  }
}

class FakePort implements DictationStreamingPort {
  readonly messages: DictationStreamingHostMessage[] = [];
  closeCount = 0;
  private listener: ((message: DictationStreamingClientMessage) => void) | null = null;

  postMessage = (message: DictationStreamingHostMessage): void => {
    this.messages.push(message);
  };

  onMessage = (listener: (message: DictationStreamingClientMessage) => void): (() => void) => {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  };

  close = (): void => {
    this.closeCount += 1;
    this.listener = null;
  };

  emit(message: DictationStreamingClientMessage): void {
    this.listener?.(message);
  }
}

class FakeSocket implements DictationStreamingSocket {
  readonly sent: string[] = [];
  closeCount = 0;
  throwOnSend = false;
  bufferedAmount = 0;
  private handlers: DictationStreamingSocketHandlers | null = null;

  send = (payload: string): void => {
    if (this.throwOnSend) throw new Error("fake send failure");
    this.sent.push(payload);
  };

  close = (): void => {
    this.closeCount += 1;
  };

  listen = (handlers: DictationStreamingSocketHandlers): (() => void) => {
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  };

  emitOpen(): void {
    this.handlers?.open();
  }

  emitMessage(message: unknown): void {
    this.handlers?.message(message);
  }

  emitError(error?: unknown): void {
    this.handlers?.error(error);
  }

  emitClose(event: Partial<DictationStreamingSocketClose> = {}): void {
    this.handlers?.close({
      code: event.code ?? 1_000,
      reason: event.reason ?? "",
      wasClean: event.wasClean ?? true,
    });
  }
}

interface Harness {
  readonly service: DictationStreamingSessionService;
  readonly port: FakePort;
  readonly clock: ManualClock;
  readonly socket: FakeSocket;
  readonly socketFactoryCalls: Array<{
    websocketUrl: string;
    protocols: readonly string[];
  }>;
}

const VALID_CONNECT_INFO: DictationStreamingConnectInfo = {
  websocketUrl: "wss://dictation.example.test/stream?token=opaque",
  protocols: ["realtime-v1"],
};

async function createHarness(
  overrides: Partial<DictationStreamingSessionServiceDependencies> = {},
): Promise<Harness> {
  const clock = new ManualClock();
  const port = new FakePort();
  const socket = new FakeSocket();
  const socketFactoryCalls: Harness["socketFactoryCalls"] = [];
  const service = new DictationStreamingSessionService({
    readConnectInfo: async () => VALID_CONNECT_INFO,
    createWebSocket: (websocketUrl, protocols) => {
      socketFactoryCalls.push({ websocketUrl, protocols });
      return socket;
    },
    clock,
    ...overrides,
  });

  service.prepare({ ownerId: "owner-1", sessionId: "session-1", sampleRateHz: 48_000, port });
  await flushPromises();
  return { service, port, clock, socket, socketFactoryCalls };
}

describe("DictationStreamingSessionService", () => {
  test("sends exact start/audio/close wire messages and completes after ordered finals", async () => {
    const harness = await createHarness();
    expect(harness.socketFactoryCalls).toEqual([
      {
        websocketUrl: "wss://dictation.example.test/stream?token=opaque",
        protocols: ["realtime-v1"],
      },
    ]);
    expect(harness.port.messages.filter((message) => message.type !== "diagnostics")).toEqual([
      { type: "prepared" },
    ]);

    harness.socket.emitOpen();
    expect(JSON.parse(harness.socket.sent[0] ?? "null")).toEqual({
      type: "session.start",
      config: {
        input_audio_format: "pcm16",
        sample_rate_hz: 48_000,
        num_channels: 1,
        max_buffer_size_bytes: 4_194_304,
        max_utterance_duration_ms: 30_000,
        session_ttl_ms: 300_000,
        provider_mode: "streaming_sse",
        transcript_delivery_mode: "final_only",
        vad: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    });

    harness.port.emit({
      type: "audio-frame",
      sequence: 0,
      pcm16: new Uint8Array([0, 1, 2, 3]).buffer,
    });
    expect(harness.socket.sent).toHaveLength(1);

    emitSessionStarted(harness.socket, 0);
    expect(JSON.parse(harness.socket.sent[1] ?? "null")).toEqual({
      type: "audio.append",
      audio: "AAECAw==",
    });
    expect(
      harness.port.messages.filter((message) => message.type !== "diagnostics").slice(1),
    ).toEqual([
      { type: "audio-ack", sequence: 0, byteLength: 4, outstandingBytes: 0 },
      { type: "started" },
    ]);
    expect(harness.clock.hasActive(DICTATION_STREAM_START_TIMEOUT_MS)).toBe(false);

    harness.port.emit({ type: "finish" });
    expect(JSON.parse(harness.socket.sent[2] ?? "null")).toEqual({ type: "session.close" });
    expect(harness.clock.hasActive(DICTATION_STREAM_FINISH_TIMEOUT_MS)).toBe(true);

    emitServer(harness.socket, {
      type: "speech.started",
      sequence_no: 1,
      utterance_id: "utterance-2",
    });
    emitServer(harness.socket, {
      type: "transcript.final",
      sequence_no: 2,
      utterance_id: "utterance-1",
      revision: 1,
      text: "world",
    });
    emitServer(harness.socket, {
      type: "transcript.final",
      sequence_no: 3,
      utterance_id: "utterance-2",
      revision: 1,
      text: "hello",
    });
    emitSessionUpdatedClosed(harness.socket, 4);

    expect(harness.port.messages.slice(-2)).toEqual([
      { type: "final", text: "hello world" },
      { type: "closed", outcome: { kind: "completed" } },
    ]);
    expect(harness.port.closeCount).toBe(1);
    expect(harness.socket.closeCount).toBe(1);
    expect(harness.clock.hasActive(DICTATION_STREAM_FINISH_TIMEOUT_MS)).toBe(false);
  });

  test("bounds queued startup audio at 4 MiB and fails the whole attempt on overflow", async () => {
    const harness = await createHarness();
    harness.socket.emitOpen();
    harness.port.emit({
      type: "audio-frame",
      sequence: 0,
      pcm16: new ArrayBuffer(DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES),
    });
    expect(harness.port.messages.filter((message) => message.type !== "diagnostics")).toEqual([
      { type: "prepared" },
    ]);

    harness.port.emit({ type: "audio-frame", sequence: 1, pcm16: new ArrayBuffer(2) });
    expect(readFailureCode(harness.port)).toBe("backpressure-overflow");
    expect(harness.port.messages.at(-1)).toEqual({
      type: "closed",
      outcome: { kind: "failed" },
    });
  });

  test("falls back when the server closes a started session before local finish", async () => {
    const harness = await createHarness();
    harness.socket.emitOpen();
    emitSessionStarted(harness.socket, 0);

    emitSessionUpdatedClosed(harness.socket, 1);

    expect(readFailureCode(harness.port)).toBe("unexpected-close");
  });

  test("bounds websocket buffered audio after the session has started", async () => {
    const harness = await createHarness();
    harness.socket.emitOpen();
    emitSessionStarted(harness.socket, 0);
    harness.socket.bufferedAmount = DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES;

    harness.port.emit({
      type: "audio-frame",
      sequence: 0,
      pcm16: new Uint8Array([0, 1]).buffer,
    });

    expect(readFailureCode(harness.port)).toBe("backpressure-overflow");
  });

  test("rejects out-of-order, empty, and non-PCM16 frames with stable fallback failures", async () => {
    for (const message of [
      { type: "audio-frame", sequence: 1, pcm16: new ArrayBuffer(2) },
      { type: "audio-frame", sequence: 0, pcm16: new ArrayBuffer(0) },
      { type: "audio-frame", sequence: 0, pcm16: new ArrayBuffer(3) },
    ] as const) {
      const harness = await createHarness();
      harness.port.emit(message);
      expect(readFailureCode(harness.port)).toBe("invalid-audio-frame");
      const failed = harness.port.messages.find((candidate) => candidate.type === "failed");
      expect(failed?.type === "failed" ? failed.error.shouldFallback : null).toBe(true);
    }
  });

  test("applies one total 10 second startup deadline, including connect-info acquisition", () => {
    const connectSignals: AbortSignal[] = [];
    const clock = new ManualClock();
    const port = new FakePort();
    const service = new DictationStreamingSessionService({
      readConnectInfo: ({ signal }) => {
        connectSignals.push(signal);
        return new Promise<DictationStreamingConnectInfo>(() => {});
      },
      createWebSocket: () => new FakeSocket(),
      clock,
    });
    service.prepare({ ownerId: "owner", sessionId: "pending", sampleRateHz: 44_100, port });

    clock.fire(DICTATION_STREAM_START_TIMEOUT_MS);
    expect(readFailureCode(port)).toBe("start-timeout");
    expect(connectSignals[0]?.aborted).toBe(true);
    expect(port.closeCount).toBe(1);
  });

  test("fails finish after 8 seconds when the server never closes the session", async () => {
    const harness = await createHarness();
    harness.socket.emitOpen();
    emitSessionStarted(harness.socket, 0);
    harness.port.emit({ type: "finish" });

    harness.clock.fire(DICTATION_STREAM_FINISH_TIMEOUT_MS);
    expect(readFailureCode(harness.port)).toBe("finish-timeout");
    expect(harness.socket.closeCount).toBe(1);
  });

  test("turns invalid payloads and server terminal events into stream-only failures", async () => {
    const cases: Array<{
      expectedCode: string;
      trigger: (socket: FakeSocket) => void;
    }> = [
      {
        expectedCode: "invalid-server-event",
        trigger: (socket) => socket.emitMessage('{"type":"unknown","sequence_no":1}'),
      },
      {
        expectedCode: "transcript-failed",
        trigger: (socket) =>
          emitServer(socket, {
            type: "transcript.failed",
            sequence_no: 1,
            utterance_id: "u1",
            error: { code: "failed", message: "raw server detail", retryable: false },
          }),
      },
      {
        expectedCode: "fatal-session-error",
        trigger: (socket) =>
          emitServer(socket, {
            type: "session.error",
            sequence_no: 1,
            fatal: true,
            error: { code: "fatal", message: "raw server detail", retryable: false },
          }),
      },
      {
        expectedCode: "abnormal-close",
        trigger: (socket) => socket.emitClose({ code: 1_006, wasClean: false }),
      },
    ];

    for (const testCase of cases) {
      const harness = await createHarness();
      harness.socket.emitOpen();
      emitSessionStarted(harness.socket, 0);
      testCase.trigger(harness.socket);
      expect(readFailureCode(harness.port)).toBe(testCase.expectedCode);
      expect(harness.port.messages.at(-1)).toEqual({
        type: "closed",
        outcome: { kind: "failed" },
      });
    }
  });

  test("ignores nonfatal session errors but rejects an empty final transcript", async () => {
    const harness = await createHarness();
    harness.socket.emitOpen();
    emitSessionStarted(harness.socket, 0);
    emitServer(harness.socket, {
      type: "session.error",
      sequence_no: 1,
      fatal: false,
      error: { code: "warning", message: "continue", retryable: true },
    });
    expect(readFailureCode(harness.port)).toBeNull();

    harness.port.emit({ type: "finish" });
    emitSessionUpdatedClosed(harness.socket, 2);
    expect(readFailureCode(harness.port)).toBe("empty-final");
  });

  test("validates connect info and contains connect or websocket failures", async () => {
    const rejected = await createHarness({
      readConnectInfo: async () => {
        throw new Error("private upstream error");
      },
    });
    expect(readFailureCode(rejected.port)).toBe("connect-info-failed");

    const invalid = await createHarness({
      readConnectInfo: async () => ({
        websocketUrl: "https://dictation.example.test/stream",
        protocols: ["realtime-v1"],
      }),
    });
    expect(readFailureCode(invalid.port)).toBe("invalid-connect-info");

    const socketFailure = await createHarness({
      createWebSocket: () => {
        throw new Error("factory failure");
      },
    });
    expect(readFailureCode(socketFailure.port)).toBe("websocket-failed");
  });

  test("maps send failures without exposing socket errors", async () => {
    const harness = await createHarness();
    harness.socket.throwOnSend = true;
    harness.socket.emitOpen();
    expect(readFailureCode(harness.port)).toBe("send-failed");
    const failed = harness.port.messages.find((message) => message.type === "failed");
    expect(failed?.type === "failed" ? failed.error.message : "").not.toContain("fake");
  });

  test("marks user abort as no-fallback and aborts pending connect work", () => {
    const signals: AbortSignal[] = [];
    const port = new FakePort();
    const service = new DictationStreamingSessionService({
      readConnectInfo: (input) => {
        signals.push(input.signal);
        return new Promise<DictationStreamingConnectInfo>(() => {});
      },
      createWebSocket: () => new FakeSocket(),
      clock: new ManualClock(),
    });
    service.prepare({ ownerId: "owner", sessionId: "session", sampleRateHz: 48_000, port });

    port.emit({ type: "abort" });
    expect(port.messages.filter((message) => message.type !== "diagnostics")).toEqual([
      { type: "closed", outcome: { kind: "aborted", shouldFallback: false } },
    ]);
    expect(signals[0]?.aborted).toBe(true);
    expect(port.closeCount).toBe(1);
  });

  test("tears down only the requested owner or matching owner/session pair", () => {
    const service = new DictationStreamingSessionService({
      readConnectInfo: () => new Promise<DictationStreamingConnectInfo>(() => {}),
      createWebSocket: () => new FakeSocket(),
      clock: new ManualClock(),
    });
    const ownerA1 = new FakePort();
    const ownerA2 = new FakePort();
    const ownerB = new FakePort();
    service.prepare({ ownerId: "owner-a", sessionId: "a1", sampleRateHz: 48_000, port: ownerA1 });
    service.prepare({ ownerId: "owner-a", sessionId: "a2", sampleRateHz: 48_000, port: ownerA2 });
    service.prepare({ ownerId: "owner-b", sessionId: "b1", sampleRateHz: 48_000, port: ownerB });

    service.teardownOwner("owner-a");
    expect(ownerA1.closeCount).toBe(1);
    expect(ownerA2.closeCount).toBe(1);
    expect(ownerB.closeCount).toBe(0);
    expect(service.teardownSession("owner-a", "b1")).toBe(false);
    expect(service.teardownSession("owner-b", "b1")).toBe(true);
    expect(ownerB.closeCount).toBe(1);
  });
});

function emitServer(socket: FakeSocket, event: Readonly<Record<string, unknown>>): void {
  socket.emitMessage(JSON.stringify(event));
}

function emitSessionStarted(socket: FakeSocket, sequenceNo: number): void {
  emitServer(socket, {
    type: "session.started",
    sequence_no: sequenceNo,
    session: {
      session_id: "server-session",
      status: "active",
      config: { provider_mode: "streaming_sse", transcript_delivery_mode: "final_only" },
    },
  });
}

function emitSessionUpdatedClosed(socket: FakeSocket, sequenceNo: number): void {
  emitServer(socket, {
    type: "session.updated",
    sequence_no: sequenceNo,
    session: {
      session_id: "server-session",
      status: "closed",
      config: { provider_mode: "streaming_sse", transcript_delivery_mode: "final_only" },
    },
  });
}

function readFailureCode(port: FakePort): string | null {
  const failed = port.messages.find((message) => message.type === "failed");
  return failed?.type === "failed" ? failed.error.code : null;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("retains handshake, actual audio sends and abnormal closure evidence for buffered recovery", async () => {
  const harness = await createHarness();
  harness.clock.time = 100;
  harness.socket.emitOpen();
  harness.clock.time = 140;
  emitSessionStarted(harness.socket, 0);
  harness.port.emit({
    type: "audio-frame",
    sequence: 0,
    pcm16: new Uint8Array([1, 2, 3, 4]).buffer,
  });
  harness.clock.time = 300;
  harness.socket.emitClose({ code: 1006, wasClean: false, reason: "private server details" });
  const message = harness.port.messages.findLast((entry) => entry.type === "diagnostics");
  expect(message).toEqual({
    type: "diagnostics",
    diagnostics: {
      attempted: true,
      opened: true,
      started: true,
      finalReceived: false,
      sentAudioFrames: 1,
      sentAudioBytes: 4,
      transcriptEvents: 0,
      connectInfoMs: 0,
      handshakeMs: 100,
      sessionStartMs: 40,
      selectedProtocol: "none",
      providerMode: "streaming_sse",
      closeCode: 1006,
      failureCode: "abnormal-close",
    },
  });
});
