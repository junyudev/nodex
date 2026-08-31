import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import type { ScriptedAcpScenario } from "../../../../scripts/scenarios/runtime/scripted-acp-agent";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import {
  make as makeApplicationSettings,
  ApplicationSettings,
} from "../../settings/ApplicationSettings";
import { live as launchProbeLive } from "../../platform/node/AcpAgentLaunchProbe";
import { live as transportLive } from "../../platform/node/AcpSessionTransport";
import { TerminalRuntimeMap } from "../../terminal-runtime/TerminalRuntimeMap";
import {
  AcpBackendSessionManager,
  make as makeManager,
  type AcpBackendSessionManagerOptions,
} from "./AcpBackendSessionManager";

const scriptedAgentPath = resolve(
  import.meta.dirname,
  "../../../../scripts/scenarios/runtime/scripted-acp-agent.ts",
);

const withManagerScenario = <A, E>(
  scenario: ScriptedAcpScenario,
  use: (input: {
    readonly manager: AcpBackendSessionManager["Service"];
    readonly workspaceRoot: string;
  }) => Effect.Effect<A, E>,
  options: AcpBackendSessionManagerOptions = {},
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "nodex-acp-manager-"));
      const packageRoot = join(root, "package");
      const workspaceRoot = join(root, "workspace");
      const observationPath = join(root, "observations.json");
      await Promise.all([
        mkdir(join(packageRoot, "dist"), { recursive: true }),
        mkdir(workspaceRoot),
      ]);
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.73.0" }),
      );
      await writeFile(
        join(packageRoot, "dist/index.js"),
        [
          'if (process.argv.includes("--version")) { console.log("0.73.0"); process.exit(0); }',
          `process.env.NODEX_SCRIPTED_ACP_SCENARIO = ${JSON.stringify(JSON.stringify(scenario))};`,
          `process.env.NODEX_SCRIPTED_ACP_OBSERVATION = ${JSON.stringify(observationPath)};`,
          `await import(${JSON.stringify(pathToFileURL(scriptedAgentPath).href)});`,
        ].join("\n"),
      );
      const nodeExecutable = execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim();
      return { root, packageRoot, workspaceRoot, nodeExecutable };
    }),
    ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap(({ root, packageRoot, workspaceRoot, nodeExecutable }) =>
      Effect.gen(function* () {
        const settings = yield* makeApplicationSettings({
          environment: {},
          settingsPath: join(root, "config.toml"),
        });
        yield* settings.update({
          type: "update-acp-agents",
          input: {
            instances: [
              {
                id: "claude-main",
                agentDefinitionId: "claude-agent-acp",
                packageRoot,
                nodeExecutable,
                enabled: true,
                credentials: { kind: "inherit-host-profile" },
                proxy: "isolated",
              },
            ],
          },
        });
        const context = yield* Layer.build(
          Layer.effect(AcpBackendSessionManager, makeManager(options)).pipe(
            Layer.provide(
              Layer.mergeAll(
                launchProbeLive,
                transportLive,
                Layer.succeed(ApplicationSettings, settings),
                mainConfigLayer({ environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }),
                Layer.succeed(
                  TerminalRuntimeMap,
                  TerminalRuntimeMap.of({} as TerminalRuntimeMap["Service"]),
                ),
              ),
            ),
          ),
        );
        return yield* use({
          manager: Context.get(context, AcpBackendSessionManager),
          workspaceRoot,
        });
      }),
    ),
  );

const openSession = (manager: AcpBackendSessionManager["Service"], workspaceRoot: string) =>
  manager.open({
    threadId: "thread-acp",
    agentDefinitionId: "claude-agent-acp",
    instanceConfigId: "claude-main",
    workspaceRoot,
    permissionPolicy: "approve-for-me",
  });

it.effect("projects load replay before publishing a restored handle", () =>
  Effect.scoped(
    withManagerScenario(
      {
        sessionId: "restored-session",
        sessionLifecycle: { load: true, loadReplay: ["restored-one", "restored-two"] },
      },
      ({ manager, workspaceRoot }) =>
        Effect.gen(function* () {
          const session = yield* manager.open({
            threadId: "thread-acp",
            agentDefinitionId: "claude-agent-acp",
            instanceConfigId: "claude-main",
            workspaceRoot,
            permissionPolicy: "approve-for-me",
            open: { kind: "load", sessionId: "restored-session" },
          });

          expect(yield* SubscriptionRef.get(session.snapshot)).toMatchObject({
            sessionId: "restored-session",
            turns: [
              {
                sequence: null,
                updates: [{ kind: "message", role: "agent", text: "restored-onerestored-two" }],
              },
            ],
          });
        }),
    ),
  ),
);

it.effect("projects a canonical turn and converges to idle", () =>
  Effect.scoped(
    withManagerScenario({ beforePrompt: ["manager-ready"] }, ({ manager, workspaceRoot }) =>
      Effect.gen(function* () {
        const session = yield* openSession(manager, workspaceRoot);
        const response = yield* session.prompt([{ type: "text", text: "hello" }]);

        expect(response.stopReason).toBe("end_turn");
        expect(yield* SubscriptionRef.get(session.status)).toEqual({ kind: "idle" });
        expect(yield* SubscriptionRef.get(session.snapshot)).toMatchObject({
          status: "idle",
          turns: [
            {
              sequence: 1,
              promptText: "hello",
              stopReason: "end_turn",
              updates: [{ kind: "message", role: "agent", text: "manager-ready" }],
            },
          ],
        });

        yield* manager.close("thread-acp");
        expect(yield* SubscriptionRef.get(session.status)).toEqual({ kind: "closed" });
        expect(yield* manager.get("thread-acp")).toBeNull();
      }),
    ),
  ),
);

it.effect("keeps ordinary prompt rejection recoverable", () =>
  Effect.scoped(
    withManagerScenario({ failFirstPromptRequest: true }, ({ manager, workspaceRoot }) =>
      Effect.gen(function* () {
        const session = yield* openSession(manager, workspaceRoot);
        const rejected = yield* session
          .prompt([{ type: "text", text: "reject once" }])
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({ reason: "request", protocolCode: -32603 });
        expect(yield* SubscriptionRef.get(session.status)).toEqual({ kind: "idle" });
        expect(yield* SubscriptionRef.get(session.snapshot)).toMatchObject({
          status: "idle",
          error: "ACP session.request failed",
        });

        const response = yield* session.prompt([{ type: "text", text: "retry" }]);
        expect(response.stopReason).toBe("end_turn");
        expect(yield* SubscriptionRef.get(session.snapshot)).toMatchObject({
          status: "idle",
          error: null,
        });
      }),
    ),
  ),
);

it.effect("publishes an initialized session for explicit multi-method authentication", () =>
  Effect.scoped(
    withManagerScenario(
      {
        authMethodIds: ["account-one", "account-two"],
        requireAuthenticationBeforeSession: true,
      },
      ({ manager, workspaceRoot }) =>
        Effect.gen(function* () {
          const session = yield* openSession(manager, workspaceRoot);
          expect(session.sessionId).toBeNull();
          expect(yield* SubscriptionRef.get(session.status)).toMatchObject({
            kind: "authentication-required",
          });

          yield* session.authenticate("account-two");

          expect(session.sessionId).toBe("scripted-root-session");
          expect(yield* SubscriptionRef.get(session.status)).toEqual({ kind: "idle" });
          expect(yield* SubscriptionRef.get(session.snapshot)).toMatchObject({
            sessionId: "scripted-root-session",
            status: "idle",
            error: null,
          });
        }),
    ),
  ),
);

it.effect("never lets a queued stale prompt reopen a closed session", () =>
  Effect.scoped(
    withManagerScenario({ waitForCancel: true }, ({ manager, workspaceRoot }) =>
      Effect.gen(function* () {
        const session = yield* openSession(manager, workspaceRoot);
        const running = yield* Effect.forkChild(
          session.prompt([{ type: "text", text: "running" }]),
        );
        yield* SubscriptionRef.changes(session.status).pipe(
          Stream.filter(({ kind }) => kind === "running"),
          Stream.runHead,
        );
        const queued = yield* Effect.forkChild(session.prompt([{ type: "text", text: "queued" }]));

        yield* manager.close("thread-acp");
        yield* Fiber.await(running);
        yield* Fiber.await(queued);

        expect(yield* SubscriptionRef.get(session.status)).toEqual({ kind: "closed" });
        expect(yield* SubscriptionRef.get(session.snapshot)).toMatchObject({
          status: "closed",
          turns: [{ promptText: "running" }],
        });
        const stale = yield* session.prompt([{ type: "text", text: "stale" }]).pipe(Effect.flip);
        expect(stale).toMatchObject({ operation: "session.prompt", reason: "request" });
        expect(yield* SubscriptionRef.get(session.status)).toEqual({ kind: "closed" });
      }),
    ),
  ),
);

it.effect("keeps observed sessions alive and evicts them after their last renderer lease", () =>
  Effect.scoped(
    withManagerScenario(
      {},
      ({ manager, workspaceRoot }) =>
        Effect.gen(function* () {
          const session = yield* openSession(manager, workspaceRoot);
          yield* manager.observe("thread-acp");

          yield* TestClock.adjust("2 seconds");
          expect(yield* manager.get("thread-acp")).toBe(session);

          yield* manager.unobserve("thread-acp");
          yield* TestClock.adjust("999 millis");
          expect(yield* manager.get("thread-acp")).toBe(session);

          yield* TestClock.adjust("1 millis");
          expect(yield* manager.get("thread-acp")).toBeNull();
          expect(yield* SubscriptionRef.get(session.status)).toEqual({ kind: "closed" });
        }),
      { idleRetention: "1 second" },
    ),
  ),
);

it.effect("rejects new sessions with typed pressure at the live-process bound", () =>
  Effect.scoped(
    withManagerScenario(
      {},
      ({ manager, workspaceRoot }) =>
        Effect.gen(function* () {
          yield* openSession(manager, workspaceRoot);

          const pressure = yield* manager
            .open({
              threadId: "thread-acp-overflow",
              agentDefinitionId: "claude-agent-acp",
              instanceConfigId: "claude-main",
              workspaceRoot,
              permissionPolicy: "approve-for-me",
            })
            .pipe(Effect.flip);

          expect(pressure).toMatchObject({
            operation: "session.capacity",
            reason: "pressure",
            retryable: true,
          });
          expect(yield* manager.get("thread-acp-overflow")).toBeNull();
        }),
      { maxLiveSessions: 1 },
    ),
  ),
);
