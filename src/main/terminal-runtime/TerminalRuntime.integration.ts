import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TerminalEnvironment } from "../platform/node/TerminalEnvironment";
import * as TerminalProcessMetrics from "../platform/node/TerminalProcessMetrics";
import * as TerminalPty from "../platform/node/TerminalPty";
import { TerminalSessions } from "./TerminalSessions";
import * as TerminalRuntimeLive from "./TerminalRuntimeLive";

it.live.skipIf(process.platform === "win32")(
  "observes shell readiness, cwd output, and exit through a real Electron PTY",
  () =>
    Effect.gen(function* () {
      const cwd = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-native-pty-"))),
        (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
      );
      yield* Effect.sync(() =>
        writeFileSync(path.join(cwd, "shellrc"), 'PS1="__NODEX_PTY_READY__ "\nunset HISTFILE\n'),
      );
      // This ABI/lifecycle contract owns its shell. Personal startup files and prompts are not inputs.
      const environment = Layer.succeed(
        TerminalEnvironment,
        TerminalEnvironment.of({
          resolve: (input) =>
            Effect.succeed({
              sessionId: input.sessionId,
              conversationId: null,
              projectSessionId: null,
              title: null,
              command: "/bin/sh",
              args: [
                "-c",
                [
                  "printf '__NODEX_PTY_STARTING__\\n'",
                  "IFS= read -r startup",
                  '[ "$startup" = "__NODEX_PTY_CONTINUE__" ] || exit 64',
                  'exec /bin/bash --noprofile --rcfile "$HOME/shellrc" -i',
                ].join("\n"),
              ],
              cwd,
              env: {
                HOME: cwd,
                PATH: "/usr/bin:/bin",
                TERM: "xterm-256color",
              },
              cols: 80,
              rows: 24,
            }),
        }),
      );
      const context = yield* Layer.build(
        TerminalRuntimeLive.layer.pipe(
          Layer.provide(Layer.mergeAll(environment, TerminalProcessMetrics.live, TerminalPty.live)),
        ),
      );
      const sessions = Context.get(context, TerminalSessions);
      const output = yield* Ref.make("");
      const starting = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const commandCompleted = yield* Deferred.make<void>();
      const exited = yield* Deferred.make<void>();
      const sessionId = "terminal-native-contract";
      const events = yield* sessions.subscribe;
      yield* Effect.forkScoped(
        events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.payload.sessionId !== sessionId) return;
              if (event.channel === "terminal-exit") {
                yield* Deferred.succeed(exited, undefined);
                return;
              }
              if (event.channel !== "terminal-data" && event.channel !== "terminal-init-log")
                return;
              const observed = yield* Ref.updateAndGet(output, (current) =>
                event.channel === "terminal-init-log"
                  ? event.payload.data
                  : current + event.payload.data,
              );
              if (observed.includes("__NODEX_PTY_STARTING__"))
                yield* Deferred.succeed(starting, undefined);
              if (observed.includes("__NODEX_PTY_READY__"))
                yield* Deferred.succeed(ready, undefined);
              if (observed.includes(`__NODEX_PTY_CWD__:${cwd}`))
                yield* Deferred.succeed(commandCompleted, undefined);
            }),
          ),
        ),
      );
      const waitForNative = Effect.fn("TerminalRuntimeIntegration.waitForNative")(
        (signal: Deferred.Deferred<void>, label: string) =>
          Deferred.await(signal).pipe(
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () =>
                Effect.gen(function* () {
                  const snapshot = yield* sessions.getSessionSnapshot(sessionId);
                  const observed = yield* Ref.get(output);
                  return yield* Effect.die(
                    new Error(
                      `Timed out waiting for ${label}: ${JSON.stringify({
                        observed,
                        buffered: snapshot?.buffer,
                        exited: snapshot?.exited,
                        exitCode: snapshot?.exitCode,
                      })}`,
                    ),
                  );
                }),
            }),
          ),
      );
      const owner = { webContentsId: 41, windowSessionId: "terminal-native-window" };
      const created = yield* sessions.create(owner, {
        sessionId,
        cwd,
        size: { cols: 80, rows: 24 },
      });
      assert.strictEqual(created.status, "acquired");
      if (created.status !== "acquired") return;
      assert.isNumber(created.snapshot.osPid);

      yield* waitForNative(starting, "PTY startup");
      assert.isFalse(yield* Deferred.isDone(ready));
      yield* sessions.write(owner, sessionId, "__NODEX_PTY_CONTINUE__\r");
      yield* waitForNative(ready, "interactive shell readiness");
      yield* sessions.write(owner, sessionId, `printf '%s:%s\\n' '__NODEX_PTY_CWD__' "$PWD"\r`);
      yield* waitForNative(commandCompleted, "PTY cwd output");
      yield* sessions.write(owner, sessionId, "exit\r");
      yield* waitForNative(exited, "PTY exit");
      const snapshot = yield* sessions.getSessionSnapshot(sessionId);
      assert.strictEqual(snapshot?.exitCode, 0);
      assert.isTrue(snapshot?.exited);
      assert.isNull(snapshot?.osPid);
    }),
);
