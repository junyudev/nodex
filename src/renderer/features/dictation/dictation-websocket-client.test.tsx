import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import { DictationWebSocketClient } from "./dictation-websocket-client";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  protocol = "chatgpt-dictation";
  sent: unknown[] = [];
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
const prepareConnection = async () => () => new Socket();
const createFixture = () => {
  const diagnostics = emptyDictationStreamDiagnostics();
  const onEvent = vi.fn();
  return {
    diagnostics,
    onEvent,
    client: new DictationWebSocketClient(prepareConnection, onEvent, diagnostics),
  };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  Socket.instances = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("renderer dictation session", () => {
  it("buffers audio until session.started, sends PCM directly, and completes on session closure", async () => {
    const { client, diagnostics, onEvent } = createFixture();
    const connecting = client.connect(48_000);
    client.appendPCM16(new Uint8Array([0, 1, 2, 3]).buffer);
    await flush();
    const socket = Socket.instances[0]!;
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
  });

  it.each([false, true])(
    "requires session completion before socket closure (finishing: %s)",
    async (finishing) => {
      for (const code of [1000, 1006]) {
        const { client, diagnostics } = createFixture();
        const connecting = client.connect(48_000);
        await flush();
        const socket = Socket.instances.at(-1)!;
        socket.open();
        socket.receive(session("active"));
        await connecting;
        const result = finishing ? client.finish().catch((error: unknown) => error) : null;
        socket.end(code);
        const expected = { code: code === 1000 ? "unexpected-close" : "abnormal-close" };
        if (result) expect(await result).toMatchObject(expected);
        else await expect(client.finish()).rejects.toMatchObject(expected);
        expect(diagnostics.closeCode).toBe(code);
        expect(diagnostics.failureCode).toBe(expected.code);
      }
    },
  );

  it.each([1000, 1005, 1006])(
    "does not mark an acknowledged session as failed on socket close %s",
    async (code) => {
      const { client, diagnostics } = createFixture();
      const connecting = client.connect(48_000);
      await flush();
      const socket = Socket.instances[0]!;
      socket.open();
      socket.receive(session("active"));
      await connecting;
      const finishing = client.finish();
      socket.receive(session("closed"));
      await finishing;
      socket.end(code);
      await expect(client.finish()).resolves.toBeUndefined();
      expect(diagnostics.closeCode).toBe(code);
      expect(diagnostics.failureCode).toBeUndefined();
    },
  );

  it("bounds startup and finalization waits", async () => {
    vi.useFakeTimers();
    const startup = createFixture();
    const connecting = startup.client.connect(48_000).catch((error: unknown) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await connecting).toMatchObject({ code: "handshake-timeout" });
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

  it("cancels pending connection preparation without opening a late socket", async () => {
    let resolve!: (value: () => Socket) => void;
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
    resolve(() => new Socket());
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

it.each([true, false])(
  "keeps startup PCM private until the admission gate resolves (%s)",
  async (allowed) => {
    let admit!: (allowed: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      admit = resolve;
    });
    const { client } = createFixture();
    const connecting = client.connect(48_000, true, gate);
    client.appendPCM16(new Uint8Array([1, 2]).buffer);
    await flush();
    const socket = Socket.instances[0]!;
    socket.open();
    socket.receive(session("active"));
    await flush();
    expect(socket.sent).toEqual([
      expect.objectContaining({
        type: "session.start",
        config: expect.objectContaining({ transcript_delivery_mode: "segment" }),
      }),
    ]);
    admit(allowed);
    await connecting;
    expect(
      socket.sent.filter((message) => (message as { type: string }).type === "audio.append"),
    ).toHaveLength(allowed ? 1 : 0);
    expect(socket.readyState).toBe(allowed ? Socket.OPEN : 3);
    client.close();
    socket.end();
  },
);

it("does not drain audio when a late gate resolves after startup timed out", async () => {
  vi.useFakeTimers();
  let admit!: (allowed: boolean) => void;
  const { client } = createFixture();
  const result = client
    .connect(
      48_000,
      true,
      new Promise<boolean>((resolve) => {
        admit = resolve;
      }),
    )
    .catch((error: unknown) => error);
  client.appendPCM16(new Uint8Array([1, 2]).buffer);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  socket.receive(session("active"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toMatchObject({ code: "session-start-timeout" });
  admit(true);
  await flush();
  expect(socket.sent).toHaveLength(1);
  socket.end();
});

it("keeps an acknowledged result authoritative if the closing transport emits an error", async () => {
  const { client, diagnostics } = createFixture();
  const connecting = client.connect(48_000);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  socket.receive(session("active"));
  await connecting;
  const finishing = client.finish();
  socket.receive(session("closed"));
  await finishing;
  socket.dispatchEvent(new Event("error"));
  socket.end(1006);
  expect(diagnostics.failureCode).toBeUndefined();
  await expect(client.finish()).resolves.toBeUndefined();
});

it("rejects a stalled preparation and never creates its late transport", async () => {
  vi.useFakeTimers();
  let accept!: (factory: () => Socket) => void;
  const factory = vi.fn(() => new Socket());
  const client = new DictationWebSocketClient(
    () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
    () => undefined,
    emptyDictationStreamDiagnostics(),
  );
  const connecting = client.connect(48_000).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await connecting).toMatchObject({ code: "prepare-timeout" });
  accept(factory);
  await flush();
  expect(factory).not.toHaveBeenCalled();
  client.close();
});

it("distinguishes an upgraded socket from an unacknowledged session start", async () => {
  vi.useFakeTimers();
  const { client } = createFixture();
  const connecting = client.connect(48_000).catch((error: unknown) => error);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await connecting).toMatchObject({ code: "session-start-timeout" });
  expect(socket.readyState).toBe(3);
});

it("rejects immediately on transport error without waiting for its close or startup deadline", async () => {
  const { client, diagnostics } = createFixture();
  const connecting = client.connect(48_000).catch((error: unknown) => error);
  await flush();
  const socket = Socket.instances[0]!;
  socket.dispatchEvent(new Event("error"));
  expect(await connecting).toMatchObject({ code: "websocket-failed" });
  expect(diagnostics.failureCode).toBe("websocket-failed");
  expect(socket.readyState).toBe(3);
});

it("cancels active startup and ignores late admission, open, and transcript events", async () => {
  let accept!: (allowed: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    accept = resolve;
  });
  const { client, diagnostics, onEvent } = createFixture();
  const connecting = client.connect(48_000, true, gate).catch((error: unknown) => error);
  await flush();
  const socket = Socket.instances[0]!;
  client.appendPCM16(new Uint8Array([1, 2]).buffer);
  client.close();
  expect(await connecting).toMatchObject({ code: "aborted" });
  socket.open();
  socket.receive(session("active"));
  accept(true);
  await flush();
  expect(socket.sent).toEqual([]);
  expect(onEvent).not.toHaveBeenCalled();
  expect(diagnostics.opened).toBe(false);
});

it("rejects finalization on cancellation and ignores late server completion", async () => {
  const { client } = createFixture();
  const connecting = client.connect(48_000);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  socket.receive(session("active"));
  await connecting;
  const finishing = client.finish().catch((error: unknown) => error);
  client.close();
  expect(await finishing).toMatchObject({ code: "aborted" });
  socket.receive(session("closed"));
});

it("honors the Composer finalization budget and serializes its session identifiers", async () => {
  vi.useFakeTimers();
  const client = new DictationWebSocketClient(
    prepareConnection,
    () => undefined,
    emptyDictationStreamDiagnostics(),
    undefined,
    {
      finishTimeoutMs: 60_000,
      dictationSessionId: "capture",
      attemptId: "segment",
      language: "zh",
    },
  );
  const connecting = client.connect(48_000, true);
  await flush();
  const socket = Socket.instances[0]!;
  socket.open();
  expect(socket.sent[0]).toMatchObject({
    dictation_session_id: "capture",
    attempt_id: "segment",
    config: { language: "zh", transcript_delivery_mode: "segment" },
  });
  socket.receive(session("active"));
  await connecting;
  let settled = false;
  const finishing = client.finish().catch((error: unknown) => {
    settled = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await finishing).toMatchObject({ code: "finish-timeout" });
});
