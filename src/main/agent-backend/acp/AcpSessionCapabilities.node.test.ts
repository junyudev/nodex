import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";
import type { ScriptedAcpScenario } from "../../../../scripts/scenarios/runtime/scripted-acp-agent";
import { live as transportLive } from "../../platform/node/AcpSessionTransport";
import { live as terminalPtyLive } from "../../platform/node/TerminalPty";
import { live as terminalRuntimeLive } from "../../terminal-runtime/TerminalRuntimeMap";
import {
  interactiveWorkspaceAcpClientCapabilities,
  live as capabilityLive,
} from "./AcpClientCapabilityOwner";
import { AcpInteractionAuthority } from "./AcpInteractionAuthority";
import {
  AcpSessionRuntime,
  layer,
  toAcpBackendCapabilityProfile,
  type AcpSessionRuntimeOptions,
} from "./AcpSessionRuntime";
import { live as terminalOwnerLive } from "./AcpTerminalOwner";
import { live as workspaceFileLive } from "./AcpWorkspaceFileOwner";

const scriptedAgentPath = resolve(
  import.meta.dirname,
  "../../../../scripts/scenarios/runtime/scripted-acp-agent.ts",
);

const makeOptions = (
  directory: string,
  observationPath: string,
  scenario: ScriptedAcpScenario,
): AcpSessionRuntimeOptions => ({
  cwd: directory,
  clientInfo: { name: "nodex-acp-capability-test", version: "1" },
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
});

it("projects authentication methods without leaking protocol launch metadata", () => {
  expect(
    toAcpBackendCapabilityProfile({
      protocolVersion: 1,
      authMethods: [
        {
          id: "account",
          name: "Account",
          description: "Sign in through the Agent",
          _meta: { providerOnly: true },
        },
        {
          id: "terminal",
          name: "Terminal",
          type: "terminal",
          args: ["login", "--secret-bearing-option"],
          env: { ACP_PRIVATE_AUTH_TOKEN: "do-not-project" },
          _meta: { providerOnly: true },
        },
      ],
    }).authMethods,
  ).toEqual([
    {
      id: "account",
      name: "Account",
      description: "Sign in through the Agent",
      kind: "agent",
    },
    {
      id: "terminal",
      name: "Terminal",
      description: null,
      kind: "terminal",
    },
  ]);
});

const withFixture = <A, E>(
  scenario: (directory: string) => ScriptedAcpScenario,
  use: (input: {
    readonly runtime: AcpSessionRuntime["Service"];
    readonly directory: string;
    readonly observationPath: string;
    readonly completedElicitations: readonly string[];
  }) => Effect.Effect<A, E>,
): Effect.Effect<A, E | import("./AcpRuntimeError").AcpRuntimeError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-acp-capability-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((directory) => {
      const observationPath = join(directory, "observation.json");
      const workspace = workspaceFileLive({ workspaceRoot: directory });
      const terminalRuntimes = terminalRuntimeLive.pipe(Layer.provide(terminalPtyLive));
      const terminal = terminalOwnerLive({
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TERM: "xterm-256color",
        },
      }).pipe(Layer.provide(Layer.merge(workspace, terminalRuntimes)));
      const completedElicitations: string[] = [];
      const interaction = Layer.succeed(
        AcpInteractionAuthority,
        AcpInteractionAuthority.of({
          requestPermission: (request) =>
            Effect.succeed({
              outcome: {
                outcome: "selected",
                optionId: request.options[0]?.optionId ?? "deny",
              },
            }),
          createElicitation: (request) =>
            Effect.succeed(
              request.mode === "form"
                ? { action: "accept", content: { answer: "scripted" } }
                : { action: "accept" },
            ),
          completeElicitation: ({ elicitationId }) =>
            Effect.sync(() => completedElicitations.push(elicitationId)),
        }),
      );
      const capabilities = capabilityLive(interactiveWorkspaceAcpClientCapabilities).pipe(
        Layer.provide(Layer.mergeAll(interaction, workspace, terminal)),
      );
      return Layer.build(
        layer(makeOptions(directory, observationPath, scenario(directory))).pipe(
          Layer.provide(Layer.merge(transportLive, capabilities)),
        ),
      ).pipe(
        Effect.flatMap((context) =>
          use({
            runtime: Context.get(context, AcpSessionRuntime),
            directory,
            observationPath,
            completedElicitations,
          }),
        ),
      );
    }),
  );

type Observation = ReadonlyArray<{
  readonly method: string;
  readonly content?: string;
  readonly output?: string;
  readonly action?: string;
  readonly clientCapabilities?: unknown;
}>;

it.effect("serves advertised filesystem, terminal, and form elicitation capabilities", () =>
  Effect.scoped(
    withFixture(
      (directory) => ({
        fsWrite: { path: join(directory, "agent.txt"), content: "one\ntwo\nthree\n" },
        fsRead: { path: join(directory, "agent.txt"), line: 2, limit: 1 },
        terminal: { command: "/bin/sh", args: ["-c", "printf terminal-ok"] },
        elicitation: "form",
      }),
      ({ runtime, directory, observationPath }) =>
        Effect.gen(function* () {
          const response = yield* runtime.prompt([{ type: "text", text: "capabilities" }]);
          const observations = JSON.parse(
            yield* Effect.promise(() => readFile(observationPath, "utf8")),
          ) as Observation;

          expect(response.stopReason).toBe("end_turn");
          expect(yield* Effect.promise(() => readFile(join(directory, "agent.txt"), "utf8"))).toBe(
            "one\ntwo\nthree\n",
          );
          expect(observations).toContainEqual({ method: "fs/write_text_file" });
          expect(observations).toContainEqual({ method: "fs/read_text_file", content: "two" });
          expect(observations).toContainEqual(
            expect.objectContaining({ method: "terminal", output: "terminal-ok" }),
          );
          expect(observations).toContainEqual({
            method: "elicitation/create",
            mode: "form",
            action: "accept",
          });
          const initialize = observations.find(({ method }) => method === "initialize");
          expect(initialize?.clientCapabilities).toMatchObject({
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            auth: { terminal: false },
            elicitation: { form: {}, url: {} },
          });
        }),
    ),
  ),
);

it.effect("routes stable agent authentication and URL elicitation completion", () =>
  Effect.scoped(
    withFixture(
      () => ({ authMethodId: "scripted-auth", elicitation: "url" }),
      ({ runtime, observationPath, completedElicitations }) =>
        Effect.gen(function* () {
          yield* runtime.authenticate("scripted-auth");
          yield* runtime.prompt([{ type: "text", text: "elicit" }]);
          const observations = JSON.parse(
            yield* Effect.promise(() => readFile(observationPath, "utf8")),
          ) as Observation;

          expect(observations).toContainEqual({
            method: "authenticate",
            methodId: "scripted-auth",
          });
          expect(observations).toContainEqual({
            method: "elicitation/complete",
            elicitationId: "scripted-elicitation",
          });
          expect(completedElicitations).toEqual(["scripted-elicitation"]);
        }),
    ),
  ),
);

it.effect("authenticates once and retries session open without replaying a prompt", () =>
  Effect.scoped(
    withFixture(
      () => ({
        authMethodId: "scripted-auth",
        requireAuthenticationBeforeSession: true,
      }),
      ({ runtime, observationPath }) =>
        Effect.gen(function* () {
          expect(runtime.sessionId).toBe("scripted-root-session");
          const observations = JSON.parse(
            yield* Effect.promise(() => readFile(observationPath, "utf8")),
          ) as Observation;

          expect(observations.map(({ method }) => method)).toEqual([
            "initialize",
            "session/new",
            "authenticate",
            "session/new",
          ]);
          expect(observations.some(({ method }) => method === "session/prompt")).toBe(false);
        }),
    ),
  ),
);

it.effect(
  "keeps an initialized Agent alive while the user selects among authentication methods",
  () =>
    Effect.scoped(
      withFixture(
        () => ({
          authMethodIds: ["account-one", "account-two"],
          requireAuthenticationBeforeSession: true,
        }),
        ({ runtime, observationPath }) =>
          Effect.gen(function* () {
            expect(runtime.sessionId).toBeNull();
            expect(runtime.capabilities.authMethods.map(({ id }) => id)).toEqual([
              "account-one",
              "account-two",
            ]);

            yield* runtime.authenticate("account-two");

            expect(runtime.sessionId).toBe("scripted-root-session");
            const observations = JSON.parse(
              yield* Effect.promise(() => readFile(observationPath, "utf8")),
            ) as Observation;
            expect(observations.map(({ method }) => method)).toEqual([
              "initialize",
              "session/new",
              "authenticate",
              "session/new",
            ]);
          }),
      ),
    ),
);
