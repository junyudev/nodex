import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { live as transportLive } from "../../platform/node/AcpSessionTransport";
import { AcpSessionRuntime, layer, type AcpSessionRuntimeOptions } from "./AcpSessionRuntime";
import { denied as deniedCapabilities } from "./AcpClientCapabilityOwner";
import type { ScriptedAcpScenario } from "../../../../scripts/scenarios/runtime/scripted-acp-agent";

const scriptedAgentPath = resolve(
  import.meta.dirname,
  "../../../../scripts/scenarios/runtime/scripted-acp-agent.ts",
);

const makeOptions = (
  directory: string,
  observationPath: string,
  scenario: ScriptedAcpScenario,
  overrides: Partial<AcpSessionRuntimeOptions> = {},
): AcpSessionRuntimeOptions => ({
  cwd: directory,
  clientInfo: { name: "nodex-acp-test", version: "1" },
  spawn: {
    command: process.execPath,
    args: ["--import", "tsx", scriptedAgentPath],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODEX_SCRIPTED_ACP_OBSERVATION: observationPath,
      NODEX_SCRIPTED_ACP_SCENARIO: JSON.stringify(scenario),
    },
    forceTermination: "250 millis",
  },
  initializeTimeout: "5 seconds",
  promptTimeout: "5 seconds",
  cancelTimeout: "1 second",
  ...overrides,
});

const withFixture = <A, E>(
  scenario: ScriptedAcpScenario,
  use: (input: {
    readonly runtime: AcpSessionRuntime["Service"];
    readonly observationPath: string;
  }) => Effect.Effect<A, E>,
  overrides?: Partial<AcpSessionRuntimeOptions>,
): Effect.Effect<A, E | import("./AcpRuntimeError").AcpRuntimeError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-acp-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((directory) => {
      const observationPath = join(directory, "observation.json");
      return Layer.build(
        layer(makeOptions(directory, observationPath, scenario, overrides)).pipe(
          Layer.provide(Layer.merge(transportLive, deniedCapabilities)),
        ),
      ).pipe(
        Effect.flatMap((context) =>
          use({ runtime: Context.get(context, AcpSessionRuntime), observationPath }),
        ),
      );
    }),
  );

const messageText = (event: unknown): string | undefined => {
  if (typeof event !== "object" || event === null || !("kind" in event)) return undefined;
  if (event.kind !== "session_update" || !("update" in event)) return undefined;
  const update = event.update;
  if (typeof update !== "object" || update === null || !("content" in update)) return undefined;
  const content = update.content;
  if (typeof content !== "object" || content === null || !("text" in content)) return undefined;
  return typeof content.text === "string" ? content.text : undefined;
};

it.effect("routes only the root session and emits a stop after drained updates", () =>
  Effect.scoped(
    withFixture(
      {
        beforePrompt: ["first", "second"],
        foreignSessionUpdates: ["foreign"],
      },
      ({ runtime }) =>
        Effect.gen(function* () {
          const response = yield* runtime.prompt([{ type: "text", text: "hello" }]);
          const events = yield* runtime.events.pipe(Stream.take(3), Stream.runCollect);

          expect(response.stopReason).toBe("end_turn");
          expect(events.map(messageText)).toEqual(["first", "second", undefined]);
          expect(events.at(-1)).toMatchObject({
            kind: "turn_stopped",
            sessionId: "scripted-root-session",
            turnSequence: 1,
          });
        }),
    ),
  ),
);

it.effect("keeps accepting late root updates until a cancelled turn stops", () =>
  Effect.scoped(
    withFixture(
      { beforePrompt: ["started"], waitForCancel: true, afterCancel: ["late"] },
      ({ runtime }) =>
        Effect.gen(function* () {
          const promptFiber = yield* Effect.forkChild(
            runtime.prompt([{ type: "text", text: "cancel me" }]),
          );
          const first = Option.getOrThrow(yield* Stream.runHead(runtime.events));
          expect(messageText(first)).toBe("started");

          yield* runtime.cancel;
          const response = yield* Fiber.join(promptFiber);
          const remaining = yield* runtime.events.pipe(Stream.take(2), Stream.runCollect);

          expect(response.stopReason).toBe("cancelled");
          expect(remaining.map(messageText)).toEqual(["late", undefined]);
          expect(remaining.at(-1)).toMatchObject({ kind: "turn_stopped", turnSequence: 1 });
        }),
    ),
  ),
);

it.effect("serializes prompts and assigns one sequence to each complete turn", () =>
  Effect.scoped(
    withFixture({ beforePrompt: ["turn"] }, ({ runtime }) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            runtime.prompt([{ type: "text", text: "first" }]),
            runtime.prompt([{ type: "text", text: "second" }]),
          ],
          { concurrency: 2 },
        );
        const events = yield* runtime.events.pipe(Stream.take(4), Stream.runCollect);

        expect(events.map(({ turnSequence }) => turnSequence)).toEqual([1, 1, 2, 2]);
        expect(events.map(({ kind }) => kind)).toEqual([
          "session_update",
          "turn_stopped",
          "session_update",
          "turn_stopped",
        ]);
      }),
    ),
  ),
);

it.effect("keeps the ACP process usable after an ordinary prompt request rejection", () =>
  Effect.scoped(
    withFixture({ failFirstPromptRequest: true }, ({ runtime }) =>
      Effect.gen(function* () {
        const first = yield* runtime
          .prompt([{ type: "text", text: "reject once" }])
          .pipe(Effect.flip);
        expect(first).toMatchObject({ reason: "request", protocolCode: -32603 });

        const response = yield* runtime.prompt([{ type: "text", text: "try again" }]);
        expect(response.stopReason).toBe("end_turn");
        expect(() => process.kill(runtime.pid, 0)).not.toThrow();
      }),
    ),
  ),
);

it.effect("fails closed when an agent requests permission", () =>
  Effect.scoped(
    withFixture({ requestPermission: true }, ({ runtime, observationPath }) =>
      Effect.gen(function* () {
        const response = yield* runtime.prompt([{ type: "text", text: "write" }]);
        const observations = JSON.parse(
          yield* Effect.promise(() => readFile(observationPath, "utf8")),
        ) as ReadonlyArray<{ readonly method: string; readonly outcome?: string }>;

        expect(response.stopReason).toBe("cancelled");
        expect(observations).toContainEqual({
          method: "session/request_permission",
          outcome: "cancelled",
        });
        expect(observations.some(({ method }) => method === "session/cancel")).toBe(true);
      }),
    ),
  ),
);

it.effect("terminates a session whose bounded event queue overflows", () =>
  Effect.scoped(
    withFixture(
      { beforePrompt: ["one", "two", "three"] },
      ({ runtime }) =>
        runtime.prompt([{ type: "text", text: "overflow" }]).pipe(
          Effect.flip,
          Effect.map((error) => {
            expect(error).toMatchObject({
              _tag: "AcpRuntimeError",
              operation: "session.events",
              reason: "pressure",
            });
          }),
        ),
      { eventCapacity: 1 },
    ),
  ),
);

it.effect("makes an exact-capacity event drain barrier a terminal pressure failure", () =>
  Effect.scoped(
    withFixture(
      {
        sessionId: "restored-session",
        sessionLifecycle: { load: true, loadReplay: ["fills-the-event-queue"] },
      },
      ({ runtime }) =>
        Effect.gen(function* () {
          const drained = yield* runtime.drainEvents.pipe(Effect.flip);
          expect(drained).toMatchObject({
            operation: "session.events.drain",
            reason: "pressure",
          });
          const terminated = yield* runtime.termination.pipe(Effect.flip);
          expect(terminated).toBe(drained);
        }),
      {
        eventCapacity: 1,
        open: { kind: "load", sessionId: "restored-session" },
      },
    ),
  ),
);

it.effect("rejects an incompatible stable-v1 initialization response", () =>
  Effect.scoped(
    withFixture({ initializeProtocolVersion: 2 }, () => Effect.void).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toMatchObject({
          _tag: "AcpRuntimeError",
          operation: "session.initialize-response",
          reason: "initialize",
        });
      }),
    ),
  ),
);

it.effect("negotiates lifecycle, modes, and config instead of guessing by agent identity", () =>
  Effect.scoped(
    withFixture(
      {
        sessionLifecycle: {
          list: true,
          delete: true,
          resume: true,
          close: true,
        },
        sessionModes: { currentModeId: "code", availableModeIds: ["ask", "code"] },
        sessionConfig: {
          id: "model",
          currentValue: "sonnet",
          values: ["sonnet", "opus"],
        },
      },
      ({ runtime, observationPath }) =>
        Effect.gen(function* () {
          expect(runtime.capabilities.session).toMatchObject({
            load: false,
            list: true,
            delete: true,
            resume: true,
            unstableFork: false,
            close: true,
          });
          expect(runtime.modes?.currentModeId).toBe("code");
          expect(runtime.configOptions).toHaveLength(1);

          const listed = yield* runtime.listSessions;
          expect(listed.sessions[0]?.sessionId).toBe("scripted-root-session");
          yield* runtime.setMode("ask");
          const configured = yield* runtime.setConfigOption("model", "opus");
          expect(configured).toHaveLength(1);
          yield* runtime.deleteSession("old-session");

          const observations = JSON.parse(
            yield* Effect.promise(() => readFile(observationPath, "utf8")),
          ) as ReadonlyArray<{ readonly method: string }>;
          expect(observations.map(({ method }) => method)).toEqual(
            expect.arrayContaining([
              "session/list",
              "session/set_mode",
              "session/set_config_option",
              "session/delete",
            ]),
          );
        }),
    ),
  ),
);

it.effect("loads replay updates before exposing the resumed session", () =>
  Effect.scoped(
    withFixture(
      {
        sessionId: "existing-session",
        sessionLifecycle: { load: true, loadReplay: ["old-one", "old-two"] },
      },
      ({ runtime }) =>
        Effect.gen(function* () {
          expect(runtime.sessionId).toBe("existing-session");
          const replay = yield* runtime.events.pipe(Stream.take(2), Stream.runCollect);
          expect(replay.map(messageText)).toEqual(["old-one", "old-two"]);
          expect(replay.every(({ turnSequence }) => turnSequence === null)).toBe(true);
        }),
      { open: { kind: "load", sessionId: "existing-session" } },
    ),
  ),
);

it.effect("rejects resume before sending a method the agent did not advertise", () =>
  Effect.scoped(
    withFixture({}, () => Effect.void, {
      open: { kind: "resume", sessionId: "existing-session" },
    }).pipe(
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ reason: "capability" })),
    ),
  ),
);

it.effect("closes the owned agent process when its session Scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-acp-scope-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        layer(makeOptions(directory, join(directory, "observation.json"), {})).pipe(
          Layer.provide(Layer.merge(transportLive, deniedCapabilities)),
        ),
        scope,
      );
      const runtime = Context.get(context, AcpSessionRuntime);
      expect(() => process.kill(runtime.pid, 0)).not.toThrow();

      yield* Scope.close(scope, Exit.void);
      expect(() => process.kill(runtime.pid, 0)).toThrow();
    }),
  ),
);

it.effect("surfaces unexpected agent termination through the typed session failure", () =>
  Effect.scoped(
    withFixture({}, ({ runtime }) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => process.kill(runtime.pid, "SIGKILL"));
        const error = yield* runtime.termination.pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "AcpRuntimeError",
          reason: "session-lost",
          retryable: true,
          pid: runtime.pid,
        });
      }),
    ),
  ),
);
