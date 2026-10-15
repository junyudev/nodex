import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexClient from "@nodex/effect-codex-app-server/client";

it.layer(NodeServices.layer)("native execution peer", (it) => {
  it.effect(
    "serves validated discovery and persists a completed native Turn across process restart",
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-runtime-peer-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        );
        const executable = join(home, "codex.mjs");
        yield* Effect.promise(() => writeFile(join(home, "plan.json"), "{}"));
        yield* Effect.promise(() =>
          copyFile(
            resolve(
              import.meta.dirname,
              "../../../tests/e2e/fixtures/agent-runtime-cross-provider-peer.mjs",
            ),
            executable,
          ),
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const open = Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(globalThis.process.execPath, [executable], {
              cwd: home,
              env: {
                ...globalThis.process.env,
                NODEX_TEST_CROSS_PROVIDER_HOME: home,
                CODEX_HOME: home,
              },
            }),
          );
          return CodexClient.layerChildProcess(handle);
        });
        const initialize = Effect.gen(function* () {
          const client = yield* CodexClient.CodexAppServerClient;
          yield* client.request("initialize", {
            clientInfo: { name: "nodex-peer-test", version: "1", title: "Native peer" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: null },
          });
          yield* client.notify("initialized", undefined);
          return client;
        });
        const threadId = yield* Effect.scoped(
          Effect.gen(function* () {
            const layer = yield* open;
            return yield* Effect.gen(function* () {
              const client = yield* initialize;
              assert.deepEqual((yield* client.request("plugin/list", {})).featuredPluginIds, []);
              assert.deepEqual((yield* client.request("plugin/installed", {})).marketplaces, []);
              assert.equal((yield* client.request("config/read", {})).config.browser_use, null);
              assert.equal((yield* client.request("config/read", {})).config.computer_use, null);
              assert.equal((yield* client.request("account/read", {})).requiresOpenaiAuth, false);
              assert.equal((yield* client.request("model/list", {})).data[0]?.model, "gpt-5.5");
              const thread = yield* client.request("thread/start", { cwd: home });
              const completed = yield* client.notifications.pipe(
                Stream.filter((notification) => notification.method === "item/completed"),
                Stream.runHead,
                Effect.forkChild,
              );
              const accepted = yield* client.request("turn/start", {
                threadId: thread.thread.id,
                input: [{ type: "text", text: "Native peer result", text_elements: [] }],
              });
              const event = yield* Fiber.join(completed);
              assert.isTrue(Option.isSome(event));
              if (
                Option.isNone(event) ||
                event.value.protocol !== "generated" ||
                event.value.method !== "item/completed"
              )
                return yield* Effect.die(
                  "Native item completion must pass the typed notification boundary",
                );
              assert.isNumber(event.value.params.completedAtMs);
              assert.equal(accepted.turn.status, "inProgress");
              const saved = yield* client.request("thread/read", {
                threadId: thread.thread.id,
                includeTurns: true,
              });
              assert.equal(saved.thread.turns[0]?.status, "completed");
              assert.isTrue(
                saved.thread.turns[0]?.items.some(
                  (item) => item.type === "agentMessage" && item.text === "Codex child report",
                ),
              );
              return thread.thread.id;
            }).pipe(Effect.provide(layer));
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const layer = yield* open;
            yield* Effect.gen(function* () {
              const client = yield* initialize;
              const resumed = yield* client.request("thread/resume", { threadId });
              assert.equal(resumed.thread.id, threadId);
              assert.equal(resumed.thread.turns.length, 1);
              assert.equal(resumed.thread.turns[0]?.status, "completed");
            }).pipe(Effect.provide(layer));
          }),
        );
      }),
  );
});
