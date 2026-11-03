import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { homedir } from "node:os";
import { testLayer } from "../../app/MainConfig";
import { live, TerminalPty } from "./TerminalPty";

it.live.runIf(process.platform === "win32")(
  "publishes a real ConPTY PID before accepting input and releases its process",
  () =>
    Effect.gen(function* () {
      const terminal = yield* TerminalPty;
      const handle = yield* terminal.spawn({
        command: "cmd.exe",
        args: ["/d", "/q"],
        cwd: homedir(),
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        cols: 80,
        rows: 24,
      });
      expect(handle.pid).toBeGreaterThan(0);
      yield* handle.write("echo NODEX_PTY_READY\r");
      yield* handle.output.pipe(
        Stream.scan(
          () => "",
          (output, chunk) => (output + chunk).slice(-4096),
        ),
        Stream.filter((data) => data.includes("NODEX_PTY_READY")),
        Stream.runHead,
        Effect.timeout("15 seconds"),
      );
      yield* handle.write("exit 0\r");
      const exited = yield* handle.exit.pipe(Effect.timeout("10 seconds"));
      expect(exited.exitCode).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(live.pipe(Layer.provide(testLayer({ platform: "win32" })))),
    ),
);
