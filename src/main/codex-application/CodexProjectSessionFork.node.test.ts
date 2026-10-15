import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexConversationFork, type CodexConversationForkInput } from "./CodexConversationFork";
import { make } from "./CodexProjectSessionFork";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";

const sessionId = "session-source";
const sourceThreadId = "thread-source";
const childThreadId = "thread-child";

const makeHarness = (
  backendBinding: AgentBackendBinding = { kind: "codex" },
  hostId = "remote-a",
) => {
  const order: string[] = [];
  const directForks: CodexConversationForkInput[] = [];
  const settings: unknown[] = [];
  const scene = {
    browserViewScopeId: "browser-scope",
    scene: { owner: { kind: "session", sessionId } },
  } as never;
  const core = CoreModules.of({
    workspace: {
      read: (input: Parameters<CoreModuleClients["workspace"]["read"]>[0]) => {
        if (input.kind === "session") {
          return Effect.succeed({
            value: {
              kind: "session",
              session: {
                id: sessionId,
                project_id: "project-a",
                thread_id: sourceThreadId,
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        if (input.kind === "project") {
          return Effect.succeed({
            value: {
              kind: "project",
              project: {
                lifecycle: "active",
                sources: [{ root: "/workspace" }, { root: "/shared" }],
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        return Effect.die("unexpected Core read");
      },
    },
  } as unknown as CoreModuleClients);
  const directoryEntry = {
    fidelity: "materialized",
    durable: {
      threadId: sourceThreadId,
      sessionId,
      projectId: "project-a",
      executionHostId: hostId,
      backendBinding,
      cwd: "/workspace",
      executionProfile: {
        modelId: "gpt-test",
        reasoningEffort: "high",
        serviceTier: null,
      },
    },
    summary: {
      threadId: sourceThreadId,
      projectId: "project-a",
      forkedFromId: null,
      threadName: "Source title",
    },
  } as never;
  const capability = make.pipe(
    Effect.provideService(CoreModules, core),
    Effect.provideService(
      CodexGateway,
      CodexGateway.of({ localHostId: "local", events: Stream.empty } as never),
    ),
    Effect.provideService(
      CodexConversationFork,
      CodexConversationFork.of({
        prepareRenderer: () => Effect.die("unused renderer preparation"),
        executeRenderer: () => Effect.die("unused renderer execution"),
        acceptRenderer: () => Effect.die("unused renderer acceptance"),
        releaseRenderer: () => Effect.void,
        fork: (input) =>
          Effect.sync(() => {
            order.push("direct:fork");
            directForks.push(input);
            return {
              threadId: childThreadId,
              session: { id: "session-child", thread: { threadId: childThreadId } },
              conversation: { threadId: childThreadId },
              composerIntent: { prompt: "", focusNonce: 1 },
            } as never;
          }),
      }),
    ),
    Effect.provideService(
      CodexThreadDirectory,
      CodexThreadDirectory.of({
        resolve: () => Effect.succeed(directoryEntry),
      } as never),
    ),
    Effect.provideService(
      CodexThreadSettingsRuntime,
      CodexThreadSettingsRuntime.of({
        update: (input: Parameters<CodexThreadSettingsRuntime["Service"]["update"]>[0]) =>
          Effect.sync(() => {
            order.push("settings:update");
            settings.push(input);
            return {} as never;
          }),
      } as never),
    ),
  );
  return { capability, directForks, order, scene, settings };
};

it.effect("rejects an ACP Project Session before any Codex fork side effect", () =>
  Effect.gen(function* () {
    const { capability, directForks, order } = makeHarness({
      kind: "acp",
      agentDefinitionId: "claude-agent-acp",
      instanceConfigId: "claude-local",
    });
    const forks = yield* capability;
    yield* forks
      .fork({ sessionId, input: { target: "local", turnId: "turn-a" } })
      .pipe(Effect.flip);
    assert.deepEqual(directForks, []);
    assert.deepEqual(order, []);
  }),
);

it.effect("forks an exact remote Session through its native execution owner", () =>
  Effect.gen(function* () {
    const { capability, directForks, order, scene, settings } = makeHarness();
    const forks = yield* capability;
    const result = yield* forks.fork({
      sessionId,
      input: { target: "local", turnId: "turn-a", collaborationMode: "plan" },
      sourceSceneContext: scene,
    });

    assert.isTrue("session" in result);
    if (!("session" in result)) return;
    assert.strictEqual(result.session.id, "session-child");
    assert.strictEqual(result.session.thread?.threadId, childThreadId);
    assert.strictEqual(result.threadId, childThreadId);
    assert.deepEqual(result.composerIntent, { prompt: "", focusNonce: 1 });
    assert.deepEqual(directForks, [
      {
        sourceThreadId,
        lastTurnId: "turn-a",
        threadSource: "user",
        sourceSceneContext: scene,
      },
    ]);
    assert.deepEqual(settings, [
      {
        threadId: childThreadId,
        patch: { collaborationMode: "plan" },
      },
    ]);
    assert.deepEqual(order, ["direct:fork", "settings:update"]);
  }),
);

it.effect(
  "leaves a local imported history passive before any native fork or worktree publication",
  () =>
    Effect.gen(function* () {
      const fixture = makeHarness({ kind: "codex" }, "local");
      const forks = yield* fixture.capability;
      for (const target of ["local", "newWorktree"] as const) {
        const failure = yield* forks.fork({ sessionId, input: { target } }).pipe(Effect.flip);
        assert.equal(failure.operation, "admit");
      }
      assert.deepEqual(fixture.directForks, []);
      assert.deepEqual(fixture.order, []);
    }),
);

it.effect(
  "keeps the reserved destination on the exact remote owner and rejects a local worktree target",
  () =>
    Effect.gen(function* () {
      const fixture = makeHarness();
      const forks = yield* fixture.capability;
      yield* forks.fork({
        sessionId,
        destinationSessionId: "reserved-child",
        input: { target: "local" },
      });
      assert.equal(fixture.directForks[0]?.destinationSessionId, "reserved-child");
      const failure = yield* forks
        .fork({ sessionId, input: { target: "newWorktree" } })
        .pipe(Effect.flip);
      assert.equal(failure.operation, "admit");
      assert.equal(fixture.directForks.length, 1);
    }),
);
