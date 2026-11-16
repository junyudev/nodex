import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { Worker } from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { testLayer } from "../../app/MainConfig";
import { TERMINAL_OUTPUT_CHUNK_CAPACITY } from "../../runtime-limits";
import { live, TerminalPty } from "./TerminalPty";

const { spawn, readProcesses } = vi.hoisted(() => ({ spawn: vi.fn(), readProcesses: vi.fn() }));
vi.mock("node-pty", () => ({ spawn }));
vi.mock("./child-stdio-errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./child-stdio-errors")>()),
  execFileAsync: readProcesses,
}));

const config = { command: "/bin/sh", args: [], cwd: ".", env: {}, cols: 80, rows: 24 };

function mockPosixPty(onResume: () => void = () => {}) {
  const events = new EventEmitter();
  const native = {
    pid: 50_000,
    pause: vi.fn(),
    resume: vi.fn(onResume),
    kill: vi.fn(),
    onData: (listener: (data: string) => void) => {
      events.on("data", listener);
      return { dispose: () => events.off("data", listener) };
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      events.on("exit", listener);
      return { dispose: () => events.off("exit", listener) };
    },
  };
  spawn.mockReturnValueOnce(native);
  return { native, events };
}

it.live("releases a Windows PTY that exits before publishing its PID", () =>
  Effect.gen(function* () {
    const socket = new Socket();
    const events = new EventEmitter();
    const kill = vi.fn();
    const stopData = vi.fn();
    let scheduled = false;
    spawn.mockReturnValueOnce({
      pid: 0,
      _socket: socket,
      _agent: { kill },
      onData: () => ({ dispose: stopData }),
      onExit: (listener: (event: { exitCode: number }) => void) => {
        events.on("exit", listener);
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(() => events.emit("exit", { exitCode: 1 }));
        }
        return { dispose: () => events.off("exit", listener) };
      },
    });
    const terminal = yield* TerminalPty;
    const error = yield* terminal
      .spawn({ command: "powershell.exe", args: [], cwd: ".", env: {}, cols: 80, rows: 24 })
      .pipe(Effect.scoped, Effect.timeout("2 seconds"), Effect.flip);
    expect(error).toMatchObject({ _tag: "TerminalPtyError", operation: "spawn" });
    expect(kill).toHaveBeenCalledOnce();
    expect(stopData).toHaveBeenCalledOnce();
    expect(events.listenerCount("exit")).toBe(0);
    expect(socket.listenerCount("ready_datapipe")).toBe(0);
  }).pipe(Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "win32" }))))),
);

it.effect("pauses native PTY output at capacity and delivers in-flight data in order", () =>
  Effect.gen(function* () {
    const resumed = yield* Deferred.make<void>();
    const { native, events } = mockPosixPty(() => Deferred.doneUnsafe(resumed, Effect.void));
    const terminal = yield* TerminalPty;
    const handle = yield* terminal.spawn(config);
    const chunks = [
      "a".repeat(70_000),
      ...Array.from({ length: TERMINAL_OUTPUT_CHUNK_CAPACITY }, (_, index) => String(index)),
    ];
    for (const data of chunks) events.emit("data", data);
    expect(native.pause).toHaveBeenCalledOnce();
    expect(native.resume).toHaveBeenCalledTimes(0);
    const output = yield* handle.output.pipe(Stream.runCollect, Effect.forkScoped);
    yield* Deferred.await(resumed);
    events.emit("data", "last");
    events.emit("exit", { exitCode: 0 });
    expect(yield* Fiber.join(output)).toEqual([...chunks, "last"]);
    expect(yield* handle.exit).toEqual({ exitCode: 0, signal: null });
  }).pipe(Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "darwin" }))))),
);

it.effect("kills the old macOS process tree deepest first only on an action restart", () =>
  Effect.gen(function* () {
    const kill = yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(process, "kill").mockImplementation((pid) => {
          if (pid === 50_002) throw Object.assign(new Error("Already gone"), { code: "ESRCH" });
          return true;
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    readProcesses.mockResolvedValueOnce({
      stdout: "50002 50001\n50001 50000\n50003 50002\n50004 1\n50000 1\n",
    });
    const { native } = mockPosixPty();
    const terminal = yield* TerminalPty;
    yield* terminal.spawn(config).pipe(
      Effect.andThen((handle) => handle.prepareForRestart),
      Effect.scoped,
    );
    expect(readProcesses).toHaveBeenCalledExactlyOnceWith("/bin/ps", ["-ax", "-o", "pid=,ppid="], {
      timeout: 5_000,
    });
    expect(kill.mock.calls).toEqual([
      [50_003, "SIGKILL"],
      [50_002, "SIGKILL"],
      [50_001, "SIGKILL"],
    ]);
    expect(native.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");

    const ordinary = mockPosixPty();
    yield* terminal.spawn(config).pipe(Effect.scoped);
    expect(ordinary.native.kill).toHaveBeenCalledExactlyOnceWith();
    expect(readProcesses).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "darwin" }))))),
);

it.effect("owns both ConPTY pipes and ends the terminal on an asynchronous write failure", () =>
  Effect.gen(function* () {
    const output = new Socket();
    const input = new Socket();
    const { native, events } = mockPosixPty();
    const kill = vi.fn();
    Object.assign(native, { _socket: output, _agent: { inSocket: input, kill }, write: vi.fn() });
    output.on("error", (error) => {
      // Same rethrow guard as node-pty's output callback.
      if (output.listenerCount("error") < 2) throw error;
    });

    const terminal = yield* TerminalPty;
    const handle = yield* terminal.spawn(config);
    yield* handle.write("request");
    const failure = Object.assign(new Error("write EAGAIN"), { code: "EAGAIN" });
    input.emit("error", failure);
    // A second pipe error during teardown must stay owned.
    output.emit("error", new Error("stream.push() after EOF"));
    events.emit("data", "late");

    expect(kill).toHaveBeenCalledOnce();
    expect(yield* handle.exit).toEqual({ exitCode: null, signal: null });
    expect(yield* Stream.runCollect(handle.output)).toEqual([]);
    expect(yield* handle.write("next").pipe(Effect.flip)).toMatchObject({
      operation: "write",
      cause: failure,
    });
  }).pipe(Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "win32" }))))),
);

it.live("ends the terminal when the ConPTY output relay reports a stream error", () =>
  Effect.gen(function* () {
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Worker(
            `const { parentPort } = require("node:worker_threads");
         const { PassThrough } = require("node:stream");
         parentPort.once("message", () => {
           const stream = new PassThrough();
           stream.push(null);
           stream.push("late");
         });`,
            { eval: true },
          ),
      ),
      (worker) => Effect.promise(() => worker.terminate()),
    );
    const { native } = mockPosixPty();
    const kill = vi.fn();
    Object.assign(native, { _agent: { kill, _conoutSocketWorker: { _worker: worker } } });
    const terminal = yield* TerminalPty;
    const handle = yield* terminal.spawn(config);

    worker.postMessage("start", []);
    expect(yield* handle.exit).toEqual({ exitCode: null, signal: null });
    expect(yield* Stream.runCollect(handle.output)).toEqual([]);
    expect(kill).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "win32" }))))),
);
