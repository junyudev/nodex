import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { testLayer } from "../../app/MainConfig";
import { live, TerminalPty } from "./TerminalPty";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn }));

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
