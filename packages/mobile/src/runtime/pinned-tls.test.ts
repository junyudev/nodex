import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { FakePinnedTls } from "./pinned-tls.test-support";
import { makePinnedTls, TLS_FRAME_LIMIT, TLS_BODY_LIMIT, type PinnedRequest } from "./pinned-tls";
const endpoint = { url: "https://127.0.0.1/test", fingerprint: "AB".repeat(32) };

it.effect.each<Partial<PinnedRequest>>([
  { url: "http://127.0.0.1" },
  { url: "https://user:secret@host" },
  { url: "https://host/#x" },
  { fingerprint: "ab".repeat(31) },
  { fingerprint: "g".repeat(64) },
  { timeoutMs: 0 },
  { timeoutMs: 60_001 },
  { method: "CONNECT" },
  { method: "GET", body: new Uint8Array([1]) },
  { headers: { Authorization: "secret\r\nx: injected" } },
  { headers: { Host: "other" } },
  { body: new Uint8Array(TLS_BODY_LIMIT + 1), method: "POST" },
])("rejects invalid input before native admission: %j", (patch) =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    const result = yield* Effect.result(makePinnedTls(native).request({ ...endpoint, ...patch }));
    expect(Result.isFailure(result) && result.failure.code).toBe("invalid");
    expect(native.starts).toHaveLength(0);
  }),
);

it.effect("normalizes the exact pin and round-trips bytes without UTF-8 conversion", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    native.onStart = (id) =>
      native.emit(id, { type: "response", status: 201, headers: { x: "y" }, body: "AP+A" });
    const response = yield* makePinnedTls(native).request({
      ...endpoint,
      method: "POST",
      body: new Uint8Array([0, 255, 128]),
    });
    expect(response).toEqual({
      status: 201,
      headers: { x: "y" },
      body: new Uint8Array([0, 255, 128]),
    });
    expect(native.starts[0]?.options).toMatchObject({
      fingerprint: endpoint.fingerprint.toLowerCase(),
      body: "AP+A",
    });
    expect(native.active.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect.each(["pin", "timeout", "transport", "limit"] as const)(
  "preserves native %s failures and releases",
  (code) =>
    Effect.gen(function* () {
      const native = new FakePinnedTls();
      native.onStart = (id) => native.emit(id, { type: "error", code });
      const result = yield* Effect.result(makePinnedTls(native).request(endpoint));
      expect(Result.isFailure(result) && result.failure.code).toBe(code);
      expect(native.active.size).toBe(0);
    }),
);

it.effect("interruption cancels an admitted request and removes its listener", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    const fiber = yield* Effect.forkChild(makePinnedTls(native).request(endpoint));
    yield* Effect.yieldNow;
    expect(native.active.size).toBe(1);
    yield* Fiber.interrupt(fiber);
    expect(native.active.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect("scopes text/binary sockets and bounds outgoing UTF-8 and incoming queues", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    native.onStart = (id) => native.emit(id, { type: "open" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* makePinnedTls(native).openSocket({ ...endpoint, url: "wss://host/" });
        yield* socket.send("hello");
        yield* socket.send(new Uint8Array([0, 255]));
        expect(native.sent.map(({ body, binary }) => [body, binary])).toEqual([
          ["hello", false],
          ["AP8=", true],
        ]);
        const oversized = yield* Effect.result(socket.send("é".repeat(TLS_FRAME_LIMIT)));
        expect(Result.isFailure(oversized) && oversized.failure.code).toBe("limit");
        const id = native.starts[0]!.id;
        for (let i = 0; i < 129; i++) native.emit(id, { type: "message", text: "a" });
        expect(native.active.size).toBe(0);
        const overflow = yield* Effect.result(socket.take);
        expect(Result.isFailure(overflow) && overflow.failure.code).toBe("limit");
      }),
    );
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect("releases a partially admitted native operation if start throws", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    native.onStart = () => {
      throw new Error("bridge unavailable");
    };
    const result = yield* Effect.result(makePinnedTls(native).request(endpoint));
    expect(Result.isFailure(result) && result.failure.code).toBe("transport");
    expect(native.active.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect("interrupts a socket while it is still opening", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          makePinnedTls(native).openSocket({ ...endpoint, url: "wss://host/" }),
        );
        yield* Effect.yieldNow;
        expect(native.active.size).toBe(1);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(native.active.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect("cancels an unanswered upgrade at its deadline without expiring an opened stream", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    const transport = makePinnedTls(native);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* Effect.forkChild(
          Effect.result(
            transport.openSocket({ ...endpoint, url: "wss://host/", timeoutMs: 8_000 }),
          ),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(7_999);
        expect(native.active.size).toBe(1);
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(pending);
        expect(Result.isFailure(result) && result.failure.code).toBe("timeout");
        expect(native.active.size).toBe(0);
        native.onStart = (id) => native.emit(id, { type: "open" });
        const socket = yield* transport.openSocket({
          ...endpoint,
          url: "wss://host/",
          timeoutMs: 8_000,
        });
        yield* TestClock.adjust(60_000);
        expect(native.active.size).toBe(1);
        native.emit(native.starts.at(-1)!.id, { type: "message", text: "still connected" });
        expect(yield* socket.take).toEqual({ type: "message", data: "still connected" });
      }),
    );
    expect(native.active.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect("retains peer close codes and releases a socket on scope exit", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    native.onStart = (id) => native.emit(id, { type: "open" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* makePinnedTls(native).openSocket({ ...endpoint, url: "wss://host/" });
        native.emit(native.starts[0]!.id, { type: "close", code: 1008 });
        expect(yield* socket.take).toEqual({ type: "close", code: 1008 });
      }),
    );
    expect(native.active.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect("rejects malformed or oversized native response bodies and releases resources", () =>
  Effect.gen(function* () {
    for (const body of ["!!!!", "A".repeat(Math.ceil(TLS_BODY_LIMIT / 3) * 4 + 4)]) {
      const native = new FakePinnedTls();
      native.onStart = (id) =>
        native.emit(id, { type: "response", status: 200, headers: {}, body });
      const result = yield* Effect.result(makePinnedTls(native).request(endpoint));
      expect(Result.isFailure(result) && result.failure.code).toBe("limit");
      expect(native.active.size).toBe(0);
      expect(native.listeners.size).toBe(0);
    }
  }),
);

it.effect("preserves a pin failure while opening a socket", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    native.onStart = (id) => native.emit(id, { type: "error", code: "pin" });
    const result = yield* Effect.result(
      Effect.scoped(
        makePinnedTls(native).openSocket({
          ...endpoint,
          url: "wss://host.example/",
        }),
      ),
    );
    expect(Result.isFailure(result) && result.failure.code).toBe("pin");
    expect(native.active.size).toBe(0);
    expect(native.listeners.size).toBe(0);
  }),
);

it.effect("retires the receive lane immediately when a native send fails", () =>
  Effect.gen(function* () {
    const native = new FakePinnedTls();
    native.onStart = (id) => native.emit(id, { type: "open" });
    native.send = () => {
      throw new Error("Bridge closed");
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* makePinnedTls(native).openSocket({
          ...endpoint,
          url: "wss://127.0.0.1/",
        });
        const sent = yield* Effect.result(socket.send("hello"));
        const received = yield* Effect.result(socket.take);
        expect(Result.isFailure(sent) && sent.failure.code).toBe("transport");
        expect(Result.isFailure(received) && received.failure.code).toBe("transport");
        expect(native.active.size).toBe(0);
      }),
    );
    expect(native.listeners.size).toBe(0);
  }),
);
