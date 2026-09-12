import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { codexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import { makeCodexSshSessionRuntime, type CodexSshSessionConfig } from "./CodexSshSession";
import { openCodexWebSocket } from "./CodexWebSocketTransport";

const server = Effect.acquireRelease(
  Effect.sync(() => new WebSocketServer({ port: 0 })),
  (server) =>
    Effect.callback<void>((resume) => {
      for (const peer of server.clients) peer.terminate();
      server.close(() => resume(Effect.void));
    }),
);
const url = (server: WebSocketServer) => {
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing listener");
  return `ws://127.0.0.1:${address.port}`;
};
const config: CodexSshSessionConfig = { connection: { alias: "dev", host: "dev" } };
it.effect(
  "SSH reconnect reuses the persistent server; failed reconnect closes its attempt before bootstrap and initialization failure resets reuse",
  () =>
    Effect.gen(function* () {
      const listener = yield* server;
      const commands: string[] = [];
      let attempts = 0;
      let failedAttemptClosed = false;
      const runtime = makeCodexSshSessionRuntime({
        prepareEnvironment: () => Effect.succeed({}),
        runCommand: (_, command) =>
          Effect.sync(() => {
            commands.push(command);
            if (attempts === 3) expect(failedAttemptClosed).toBe(true);
            return { code: 0, stdout: "codex-cli 0.151.0", stderr: "" };
          }),
        connect: (_, hostId, generation) =>
          Effect.gen(function* () {
            attempts += 1;
            if (attempts === 3) {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  failedAttemptClosed = true;
                }),
              );
              return yield* codexRuntimeError({
                operation: "test.connect",
                reason: "session-lost",
                retryable: true,
              });
            }
            return yield* openCodexWebSocket({
              hostId,
              generation,
              createSocket: () => new WebSocket(url(listener)),
            });
          }),
      });
      const firstScope = yield* Scope.fork(yield* Effect.scope);
      yield* runtime.open(config, "remote", 1).pipe(Effect.provideService(Scope.Scope, firstScope));
      expect(commands).toHaveLength(3);
      yield* Scope.close(firstScope, Exit.void);
      yield* runtime.open(config, "remote", 2);
      expect(commands).toHaveLength(3);
      const recovered = yield* runtime.open(config, "remote", 3);
      expect(commands).toHaveLength(6);
      recovered.onInitializationFailed();
      yield* runtime.open(config, "remote", 4);
      expect(commands).toHaveLength(9);
    }),
);

it.effect("SSH startup commands and handshakes serialize across endpoints sharing an alias", () =>
  Effect.gen(function* () {
    const listener = yield* server;
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const runtime = makeCodexSshSessionRuntime({
      prepareEnvironment: () => Effect.succeed({}),
      runCommand: () =>
        Effect.gen(function* () {
          active += 1;
          maximum = Math.max(maximum, active);
          yield* Effect.yieldNow;
          active -= 1;
          calls += 1;
          return { code: 0, stdout: "codex-cli 0.151.0", stderr: "" };
        }),
      connect: (_, hostId, generation) =>
        openCodexWebSocket({
          hostId,
          generation,
          createSocket: () => new WebSocket(url(listener)),
        }),
    });
    yield* Effect.all(
      [
        runtime.open({ connection: { alias: "shared", host: "one" } }, "one", 1),
        runtime.open({ connection: { alias: "shared", host: "two" } }, "two", 1),
      ],
      { concurrency: "unbounded" },
    );
    expect(maximum).toBe(1);
    expect(calls).toBe(6);
  }),
);

it.effect(
  "unsupported remote Codex versions fail before bootstrap and leave the startup gate reusable",
  () =>
    Effect.gen(function* () {
      let version = "codex-cli 0.140.9";
      let commands = 0;
      let connections = 0;
      const runtime = makeCodexSshSessionRuntime({
        prepareEnvironment: () => Effect.succeed({}),
        runCommand: (_, command) =>
          Effect.sync(() => {
            commands += 1;
            return { code: 0, stdout: command.endsWith("--version") ? version : "", stderr: "" };
          }),
        connect: () =>
          Effect.gen(function* () {
            connections += 1;
            return yield* codexRuntimeError({
              operation: "test.connect",
              reason: "session-lost",
              retryable: true,
            });
          }),
      });
      const rejected = yield* Effect.exit(runtime.open(config, "remote", 1));
      expect(Exit.isFailure(rejected)).toBe(true);
      expect(commands).toBe(2);
      expect(connections).toBe(0);
      version = "codex-cli 0.0.0";
      yield* Effect.exit(runtime.open(config, "remote", 2));
      expect(commands).toBe(5);
      expect(connections).toBe(1);
    }),
);
