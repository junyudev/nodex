/* @effect-diagnostics asyncFunction:off processEnv:off -- Native integration fixtures. */
import { execFile } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { encodeBrowserUseNativePipeFrame } from "../../browser-use/native-pipe-framing";
import {
  WindowsDesktopTools,
  windowsDesktopToolsLayer,
  type WindowsDesktopToolsService,
} from "../node/WindowsDesktopTools";
import { makeWindowsComputerUseHostPlatform } from "./WindowsComputerUseHostPlatform";

const testOnWindows = test.skipIf(process.platform !== "win32");
const run = <T, E>(
  use: (service: WindowsDesktopToolsService) => Effect.Effect<T, E, WindowsDesktopTools>,
) =>
  Effect.runPromise(
    Effect.flatMap(WindowsDesktopTools, use).pipe(
      Effect.provide(windowsDesktopToolsLayer("win32", requiredNativeExecutable("core-server"))),
    ),
  );

const nodeEnvironment = () => ({
  SystemRoot: process.env.SystemRoot!,
  ELECTRON_RUN_AS_NODE: "1",
});

testOnWindows(
  "Computer Use rejects a different image and admits the verified pipe client",
  async () => {
    await run((service) =>
      Effect.gen(function* () {
        const host = makeWindowsComputerUseHostPlatform({
          tools: service,
          parentPid: process.pid,
          environment: {},
          runtimeStateHome: tmpdir(),
          codexCliPath: null,
        });
        const server = yield* host.start(process.execPath, process.execPath, new Set());
        // This connection's peer is the Core broker. Its path must not pass the REPL check.
        const other = yield* service.connectPipe(server.pipePath);
        const ended = once(other.stream, "end");
        other.stream.resume();
        yield* Effect.promise(() => ended).pipe(Effect.timeout("10 seconds"));
        const ping = encodeBrowserUseNativePipeFrame(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        );
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            execFile(
              process.execPath,
              [
                "-e",
                `const client = require("node:net").connect(process.argv[1]);
        let data = Buffer.alloc(0);
        client.on("connect", () => client.write(Buffer.from(process.argv[2], "hex")));
        client.on("data", chunk => {
          data = Buffer.concat([data, chunk]);
          if (data.length < 4 || data.length < 4 + data.readUInt32LE()) return;
          const reply = JSON.parse(data.subarray(4));
          if (reply.result !== "pong") process.exitCode = 1;
          client.destroy();
        });
        client.on("end", () => { if (data.length === 0) process.exitCode = 2; });`,
                server.pipePath,
                ping.toString("hex"),
              ],
              { env: nodeEnvironment(), windowsHide: true },
            ),
          ),
          (child) =>
            Effect.promise(async () => {
              if (child.exitCode !== null || child.signalCode !== null) return;
              const closed = once(child, "exit");
              child.kill();
              await closed;
            }),
        );
        const exited = once(child, "exit");
        expect(yield* Effect.promise(() => exited).pipe(Effect.timeout("15 seconds"))).toEqual([
          0,
          null,
        ]);
      }).pipe(Effect.scoped),
    );
  },
);

testOnWindows(
  "relays helper stdio under a job and kills the owned child when the lease closes",
  async () => {
    const identity = await run((service) =>
      Effect.gen(function* () {
        const helper = yield* service.spawnInJob({
          executable: process.execPath,
          args: ["-e", `process.stdin.on("data", chunk => process.stdout.write(chunk));`],
          cwd: tmpdir(),
          env: nodeEnvironment(),
        });
        expect(yield* service.processIdentity(helper.identity.pid)).toEqual(helper.identity);
        const reply = once(helper.output, "data");
        const bytes = Buffer.from([0, 0xff, 0x80, 1]);
        helper.input.write(bytes);
        expect((yield* Effect.promise(() => reply).pipe(Effect.timeout("15 seconds")))[0]).toEqual(
          bytes,
        );
        return helper.identity;
      }).pipe(Effect.scoped),
    );

    const result = await run((service) =>
      service.processIdentity(identity.pid).pipe(Effect.result),
    );
    if (result._tag === "Success")
      expect(result.success.creationTime).not.toBe(identity.creationTime);

    const code = await run((service) =>
      Effect.gen(function* () {
        const helper = yield* service.spawnInJob({
          executable: process.execPath,
          args: ["-e", "process.stdin.once('data', () => process.exit(130));"],
          cwd: tmpdir(),
          env: nodeEnvironment(),
        });
        helper.input.write("exit");
        return yield* Effect.promise(() => helper.exited).pipe(Effect.timeout("15 seconds"));
      }).pipe(Effect.scoped),
    );
    expect(code).toBe(130);
  },
);
