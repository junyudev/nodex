import { afterEach, beforeEach, expect, it, vi } from "vitest";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  protocol = "chatgpt-dictation";
  sent: Array<{ type: string; audio?: string; config?: { transcript_delivery_mode: string } }> = [];
  constructor() {
    super();
    Socket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  end(code = 1006): void {
    this.close();
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}
class Processor {
  static instances: Processor[] = [];
  port = {
    onmessage: null as
      | ((event: { data: Float32Array | string | { boundary: number } }) => void)
      | null,
    postMessage: vi.fn((message: unknown) => {
      if (message === "stop") queueMicrotask(() => this.emit("stopped"));
    }),
    close: vi.fn(),
  };
  constructor() {
    Processor.instances.push(this);
  }
  connect = vi.fn();
  disconnect = vi.fn();
  emit(data: Float32Array | string | { boundary: number }): void {
    this.port.onmessage?.({ data });
  }
}
class Context {
  sampleRate = 48_000;
  state = "running";
  destination = {};
  audioWorklet = { addModule: async () => undefined };
  createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  resume = async () => undefined;
  close = async () => undefined;
}
const session = (status: "active" | "closed") => ({
  type: status === "active" ? "session.started" : "session.updated",
  sequence_no: 0,
  session: {
    session_id: "fixture",
    status,
    config: { provider_mode: "streaming_sse", transcript_delivery_mode: "segment" },
  },
});
const transcript = (
  type: "transcript.final" | "transcript.segment" | "transcript.delta",
  text: string,
  utterance = "u1",
  revision = 1,
) => ({
  type,
  sequence_no: 1,
  utterance_id: utterance,
  revision,
  text,
});
const flush = async () => {
  for (let index = 0; index < 15; index++) await Promise.resolve();
};
const createAttempt = async () => {
  const onTranscript = vi.fn();
  const { createBrowserDictationStreamingPort } = await import("./dictation-streaming-client");
  const port = createBrowserDictationStreamingPort(async () => ({
    websocketUrl: "wss://example.test/dictation",
    protocols: [],
  }));
  const attempt = await port.prepare("session", { onTranscript });
  await flush();
  const socket = Socket.instances[0]!;
  const processor = Processor.instances[0]!;
  const starting = attempt.start({} as MediaStream);
  await flush();
  socket.open();
  socket.receive(session("active"));
  processor.emit(Float32Array.of(0.1, -0.1));
  await starting;
  return { attempt, processor, socket, onTranscript };
};
const split = async (fixture: Awaited<ReturnType<typeof createAttempt>>) => {
  const id = fixture.attempt.split();
  await flush();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  socket.receive(session("active"));
  await flush();
  return { id, socket };
};
const readBlob = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as ArrayBuffer));
    reader.addEventListener("error", reject);
    reader.readAsArrayBuffer(blob);
  });
beforeEach(() => {
  vi.resetModules();
  Socket.instances = [];
  Processor.instances = [];
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Processor);
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("switches PCM ownership only on worklet acknowledgement and publishes segment-aware text", async () => {
  const f = await createAttempt();
  expect(f.socket.sent[0]?.config?.transcript_delivery_mode).toBe("segment");
  f.socket.receive(transcript("transcript.segment", "first partial"));
  f.socket.receive(transcript("transcript.delta", "ignored delta"));
  expect(f.onTranscript).toHaveBeenLastCalledWith("first partial", {
    id: 0,
    text: "first partial",
  });
  const second = await split(f);
  expect(second.id).toBe(1);
  expect(f.processor.port.postMessage).toHaveBeenCalledWith({ boundary: 1 });
  f.processor.emit(Float32Array.of(0.2));
  expect(f.socket.sent.filter((message) => message.type === "audio.append")).toHaveLength(2);
  expect(second.socket.sent.filter((message) => message.type === "audio.append")).toHaveLength(0);
  f.processor.emit({ boundary: 1 });
  f.processor.emit(Float32Array.of(0.3));
  await flush();
  expect(f.socket.sent.at(-1)?.type).toBe("session.close");
  expect(second.socket.sent.at(-1)?.type).toBe("audio.append");
  f.socket.receive(transcript("transcript.final", "first final"));
  f.socket.receive(session("closed"));
  second.socket.receive(transcript("transcript.segment", "second partial"));
  expect(f.onTranscript).toHaveBeenLastCalledWith("first final second partial", {
    id: 1,
    text: "second partial",
  });
  const finishing = f.attempt.finish();
  await flush();
  second.socket.receive(transcript("transcript.final", "second final"));
  second.socket.receive(session("closed"));
  await expect(finishing).resolves.toBe("first final second final");
  expect(f.attempt.split()).toBeNull();
  f.attempt.abort();
});

it("recovers only failed segments as exact PCM WAV and keeps successful segment receipts", async () => {
  const f = await createAttempt();
  const second = await split(f);
  f.processor.emit({ boundary: 1 });
  f.processor.emit(Float32Array.of(0.25, -0.25, 0.5));
  await flush();
  f.socket.receive(transcript("transcript.final", "kept"));
  f.socket.receive(session("closed"));
  second.socket.receive(transcript("transcript.segment", "unfinished"));
  const finishing = f.attempt.finish();
  await flush();
  second.socket.receive(session("closed"));
  await expect(finishing).resolves.toBeNull();
  expect(f.attempt.diagnostics?.().failureCode).toBe("incomplete-transcript");
  const transcribe = vi.fn(async (blob: Blob) => {
    expect(blob.type).toBe("audio/wav");
    const bytes = await readBlob(blob);
    const view = new DataView(bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 16))).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(96_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getUint32(4, true)).toBe(42);
    const wireAudio = second.socket.sent.find((message) => message.type === "audio.append")!.audio!;
    expect(Array.from(new Uint8Array(bytes.slice(44)))).toEqual(
      Array.from(atob(wireAudio), (byte) => byte.charCodeAt(0)),
    );
    return "recovered";
  });
  await expect(f.attempt.recover(transcribe, new AbortController().signal)).resolves.toBe(
    "kept recovered",
  );
  await expect(f.attempt.recover(transcribe, new AbortController().signal)).resolves.toBe(
    "kept recovered",
  );
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(f.onTranscript).toHaveBeenLastCalledWith("kept recovered", { id: 1, text: "recovered" });
  f.attempt.abort();
});

it("retains recovered segments across HTTP retries and never emits a cancelled recovery", async () => {
  const f = await createAttempt();
  const second = await split(f);
  f.processor.emit({ boundary: 1 });
  f.processor.emit(Float32Array.of(0.2));
  f.socket.end();
  second.socket.end();
  await expect(f.attempt.finish()).resolves.toBeNull();
  const transcribe = vi
    .fn<(blob: Blob) => Promise<string>>()
    .mockResolvedValueOnce("first")
    .mockRejectedValueOnce(new Error("offline"));
  await expect(f.attempt.recover(transcribe, new AbortController().signal)).rejects.toThrow(
    "offline",
  );
  const controller = new AbortController();
  const before = f.onTranscript.mock.calls.length;
  transcribe.mockImplementationOnce(async () => {
    controller.abort();
    return "cancelled";
  });
  await expect(f.attempt.recover(transcribe, controller.signal)).rejects.toThrow();
  expect(f.onTranscript).toHaveBeenCalledTimes(before);
  transcribe.mockResolvedValueOnce("second");
  await expect(f.attempt.recover(transcribe, new AbortController().signal)).resolves.toBe(
    "first second",
  );
  expect(transcribe).toHaveBeenCalledTimes(4);
  f.attempt.abort();
});

it.each([false, true])(
  "uses transcript evidence when classifying low-energy audio (has text: %s)",
  async (hasText) => {
    const { createBrowserDictationStreamingPort } = await import("./dictation-streaming-client");
    const attempt = await createBrowserDictationStreamingPort(async () => ({
      websocketUrl: "wss://example.test/dictation",
      protocols: [],
    })).prepare("silent");
    await flush();
    const starting = attempt.start({} as MediaStream);
    await flush();
    const socket = Socket.instances[0]!;
    socket.open();
    socket.receive(session("active"));
    Processor.instances[0]!.emit(Float32Array.of(0, 0));
    await starting;
    if (hasText) socket.receive(transcript("transcript.segment", "quiet speech"));
    socket.end();
    await expect(attempt.finish()).resolves.toBe(hasText ? null : "");
    attempt.abort();
  },
);

it("times out stalled audio flushing and retains captured PCM for segment recovery", async () => {
  const f = await createAttempt();
  await split(f);
  f.processor.emit({ boundary: 1 });
  f.processor.emit(Float32Array.of(0.2));
  f.processor.port.postMessage.mockImplementation(() => undefined);
  vi.useFakeTimers();
  const finishing = f.attempt.finish();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(finishing).resolves.toBeNull();
  expect(f.attempt.diagnostics?.().failureCode).toBe("audio-flush-timeout");
  f.attempt.abort();
});

it("keeps initial connection diagnostics while accumulating every segment's traffic", async () => {
  const f = await createAttempt();
  const id = f.attempt.split();
  await flush();
  const second = Socket.instances.at(-1)!;
  second.protocol = "codex-desktop";
  second.open();
  second.receive(session("active"));
  await flush();
  f.processor.emit({ boundary: id! });
  f.processor.emit(Float32Array.of(0.2));
  await flush();
  f.socket.receive(transcript("transcript.final", "first"));
  f.socket.receive(session("closed"));
  f.socket.end(1000);
  second.receive(transcript("transcript.segment", "second"));
  second.end(1006);
  await expect(f.attempt.finish()).resolves.toBeNull();
  expect(f.attempt.diagnostics?.()).toMatchObject({
    selectedProtocol: "chatgpt-dictation",
    closeCode: 1000,
    failureCode: "abnormal-close",
    sentAudioFrames: 2,
    sentAudioBytes: 6,
    transcriptEvents: 2,
  });
  f.attempt.abort();
});

it("recovers empty failed segments without uploading an empty WAV", async () => {
  const f = await createAttempt();
  const second = await split(f);
  f.processor.emit({ boundary: 1 });
  await flush();
  f.socket.receive(transcript("transcript.final", "kept"));
  f.socket.receive(session("closed"));
  second.socket.end();
  await expect(f.attempt.finish()).resolves.toBeNull();
  const transcribe = vi.fn(async () => "unexpected");
  await expect(f.attempt.recover(transcribe, new AbortController().signal)).resolves.toBe("kept");
  expect(transcribe).not.toHaveBeenCalled();
  expect(f.onTranscript).toHaveBeenLastCalledWith("kept", { id: 1, text: "" });
  f.attempt.abort();
});

it("retains a transport failure when capture is subsequently cancelled", async () => {
  const f = await createAttempt();
  f.socket.dispatchEvent(new Event("error"));
  f.socket.end();
  f.attempt.abort();
  expect(f.attempt.diagnostics?.().failureCode).toBe("websocket-failed");
});

it("reports audio readiness before the WebSocket starts and waits for both before resolving start", async () => {
  const { createBrowserDictationStreamingPort } = await import("./dictation-streaming-client");
  const attempt = await createBrowserDictationStreamingPort(async () => ({
    websocketUrl: "wss://example.test/dictation",
    protocols: [],
  })).prepare("ready");
  await flush();
  const onReady = vi.fn();
  let started = false;
  const starting = attempt.start({} as MediaStream, undefined, onReady).then(() => {
    started = true;
  });
  await flush();
  expect(onReady).not.toHaveBeenCalled();
  Processor.instances[0]!.emit(Float32Array.of(0.1));
  await flush();
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(started).toBe(false);
  const socket = Socket.instances[0]!;
  socket.open();
  socket.receive(session("active"));
  await starting;
  expect(started).toBe(true);
  attempt.abort();
});

it("suppresses the audio-ready callback when capture stops before the first frame settles", async () => {
  const { createBrowserDictationStreamingPort } = await import("./dictation-streaming-client");
  const attempt = await createBrowserDictationStreamingPort(async () => ({
    websocketUrl: "wss://example.test/dictation",
    protocols: [],
  })).prepare("stopping");
  await flush();
  const onReady = vi.fn();
  const starting = attempt.start({} as MediaStream, undefined, onReady);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  socket.receive(session("active"));
  Processor.instances[0]!.emit(Float32Array.of(0.1));
  await attempt.stopAndFlush();
  await starting;
  expect(onReady).not.toHaveBeenCalled();
  attempt.abort();
});

it.each([true, false])(
  "retains early PCM while waiting for global confirmation (%s)",
  async (allowed) => {
    const { createBrowserDictationStreamingPort } = await import("./dictation-streaming-client");
    const attempt = await createBrowserDictationStreamingPort(async () => ({
      websocketUrl: "wss://example.test/dictation",
      protocols: [],
    })).prepare("confirmation");
    let confirm!: (value: boolean) => void;
    const confirmed = new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
    await flush();
    const starting = attempt.start(Promise.resolve({} as MediaStream), confirmed);
    await flush();
    const socket = Socket.instances[0]!;
    socket.open();
    socket.receive(session("active"));
    Processor.instances[0]!.emit(Float32Array.of(0.1, -0.1));
    await flush();
    expect(socket.sent.filter((message) => message.type === "audio.append")).toHaveLength(0);
    confirm(allowed);
    await starting;
    const frames = socket.sent.filter((message) => message.type === "audio.append");
    expect(frames).toHaveLength(allowed ? 1 : 0);
    if (allowed) expect(atob(frames[0]!.audio!)).toHaveLength(4);
    attempt.abort();
  },
);
