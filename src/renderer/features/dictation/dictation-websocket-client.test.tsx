import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import { DictationWebSocketClient } from "./dictation-websocket-client";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  protocol = "chatgpt-dictation";
  sent: unknown[] = [];
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
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
  end(code = 1000): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}
const session = (status: "active" | "closed") => ({
  type: status === "active" ? "session.started" : "session.updated",
  sequence_no: 0,
  session: {
    session_id: "test-session",
    status,
    config: { provider_mode: "streaming_sse", transcript_delivery_mode: "final_only" },
  },
});
const info = {
  websocketUrl: "wss://chatgpt.com/backend-api/transcribe/dictation/stream",
  protocols: ["chatgpt-dictation", "openai-bearer.test-secret", "codex-desktop"],
};
const createFixture = () => {
  const diagnostics = emptyDictationStreamDiagnostics();
  const onEvent = vi.fn();
  return {
    diagnostics,
    onEvent,
    client: new DictationWebSocketClient(async () => info, onEvent, diagnostics),
  };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("renderer dictation WebSocket", () => {
  it("buffers audio until session.started, sends PCM directly, and completes on session closure", async () => {
    const { client, diagnostics, onEvent } = createFixture();
    const connecting = client.connect(48_000);
    client.appendPCM16(new Uint8Array([0, 1, 2, 3]).buffer);
    await flush();
    const socket = Socket.instances[0]!;
    expect(socket.protocols).toEqual(info.protocols);
    socket.open();
    expect(socket.sent).toEqual([
      expect.objectContaining({
        type: "session.start",
        config: expect.objectContaining({
          sample_rate_hz: 48_000,
          transcript_delivery_mode: "final_only",
        }),
      }),
    ]);
    socket.receive(session("active"));
    await connecting;
    expect(socket.sent[1]).toEqual({ type: "audio.append", audio: "AAECAw==" });
    const finishing = client.finish();
    expect(client.finish()).toBe(finishing);
    expect(socket.sent[2]).toEqual({ type: "session.close" });
    socket.receive({ type: "asset.ready", sequence_no: 1 });
    socket.receive(session("closed"));
    await finishing;
    socket.end();
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(diagnostics).toMatchObject({
      opened: true,
      started: true,
      sentAudioBytes: 4,
      sentAudioFrames: 1,
    });
    expect(diagnostics.failureCode).toBeUndefined();
    expect(JSON.stringify(diagnostics)).not.toContain("test-secret");
  });

  it("accepts a normal close after startup but retains an abnormal close for buffered recovery", async () => {
    for (const code of [1000, 1006]) {
      const { client, diagnostics } = createFixture();
      const connecting = client.connect(48_000);
      await flush();
      const socket = Socket.instances.at(-1)!;
      socket.open();
      socket.receive(session("active"));
      await connecting;
      socket.end(code);
      if (code === 1000) await expect(client.finish()).resolves.toBeUndefined();
      else await expect(client.finish()).rejects.toMatchObject({ code: "abnormal-close" });
      expect(diagnostics.closeCode).toBe(code);
    }
  });

  it("bounds startup and finalization waits", async () => {
    vi.useFakeTimers();
    const startup = createFixture();
    const connecting = startup.client.connect(48_000).catch((error: unknown) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await connecting).toMatchObject({ code: "start-timeout" });
    const ending = createFixture();
    const ready = ending.client.connect(48_000);
    await flush();
    const socket = Socket.instances.at(-1)!;
    socket.open();
    socket.receive(session("active"));
    await ready;
    const finishing = ending.client.finish().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await finishing).toMatchObject({ code: "finish-timeout" });
  });

  it("cancels pending credential preparation without opening a late socket", async () => {
    let resolve!: (value: typeof info) => void;
    const client = new DictationWebSocketClient(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      () => undefined,
      emptyDictationStreamDiagnostics(),
    );
    const connecting = client.connect(48_000).catch((error: unknown) => error);
    client.close();
    expect(await connecting).toMatchObject({ code: "aborted" });
    resolve(info);
    await flush();
    expect(Socket.instances).toHaveLength(0);
  });
});

it.each([
  [{ type: "unknown", sequence_no: 2 }, "invalid-server-event"],
  [
    {
      type: "transcript.failed",
      sequence_no: 2,
      error: { code: "failed", message: "failed", retryable: true },
    },
    "transcript-failed",
  ],
  [
    {
      type: "session.error",
      sequence_no: 2,
      fatal: true,
      error: { code: "failed", message: "failed", retryable: true },
    },
    "fatal-session-error",
  ],
])("rejects finalization on terminal server event %j", async (event, code) => {
  const { client } = createFixture();
  const connecting = client.connect(48000);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  socket.receive(session("active"));
  await connecting;
  const finishing = client.finish().catch((error: unknown) => error);
  socket.receive(event);
  socket.end();
  expect(await finishing).toMatchObject({ code });
});

it("freezes finalization timing when the result completes before the socket closes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const { client, diagnostics } = createFixture();
  const connecting = client.connect(48000);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  socket.receive(session("active"));
  await connecting;
  const finishing = client.finish();
  await vi.advanceTimersByTimeAsync(250);
  socket.receive(session("closed"));
  await finishing;
  expect(diagnostics.finishMs).toBe(250);
  await vi.advanceTimersByTimeAsync(2000);
  socket.end();
  expect(diagnostics.finishMs).toBe(250);
});
