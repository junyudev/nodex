import { describe, vi, expect, test } from "vite-plus/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Project, ProjectSession, ProjectSessionSummary } from "../../shared/types";
import type { ProjectCreateCommandInput } from "../../shared/workspace-catalog-commands";
import {
  AgentRuntimeApplicationError,
  AgentRuntimeApplication,
} from "../agent-runtime/AgentRuntimeApplication";
import { turnSessionFolderIntoProject } from "./SessionFolderProjects";
import * as Layer from "effect/Layer";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { ProjectArchiveBlockers, live } from "./ProjectArchiveBlockers";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  SIDEBAR_CHAT_STATUS_SCENARIO_ID,
  requireSidebarChatStatusFacts,
} from "../../../scripts/scenarios/scenarios/sidebar-chat-status";

describe("SessionFolderProjects", () => {
  const tempDirectory = Effect.acquireRelease(
    Effect.promise(async () =>
      realpath(await mkdtemp(path.join(tmpdir(), "nodex-folder-project-"))),
    ),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

  const fixture = (
    directory: string,
    options: { readonly owner?: boolean; readonly legacy?: boolean } = {},
  ) => {
    const session = {
      id: "chat",
      projectId: null as string | null,
      executionRef: { threadId: "thread", runtimeId: "runtime" },
    };
    const projects = new Map<string, Project>();
    const creates: ProjectCreateCommandInput[] = [];
    const project = (id: string, name: string) =>
      ({
        id,
        name,
        lifecycle: "active",
        primaryWorkspaceRoot: directory,
        sources: [{ kind: "directory", order: 0, path: directory }],
      }) as Project;
    if (options.owner) projects.set("existing", project("existing", "Notes"));
    let failMove = false;
    const moves: Parameters<AgentRuntimeApplication["Service"]["moveSession"]>[0][] = [];
    const input: Parameters<typeof turnSessionFolderIntoProject>[0] = {
      sessionId: session.id,
      folders: {
        existing: (_id, optionsForExisting) =>
          options.legacy
            ? optionsForExisting!.readExecutionCwd!("thread").pipe(
                Effect.orDie,
                Effect.map((cwd) =>
                  cwd ? { path: cwd, origin: "chosen", execution_host_id: "local" } : null,
                ),
              )
            : Effect.succeed({ path: directory, origin: "generated", execution_host_id: "local" }),
      },
      readExecutionCwd: (threadId) =>
        Effect.sync(() => {
          assert.equal(threadId, "thread");
          return directory;
        }),
      projects: {
        getProjectSession: () => Effect.sync(() => session as ProjectSession),
        getProject: (id) => Effect.sync(() => projects.get(id) ?? null),
        listProjectWindow: () =>
          Effect.sync(() => ({
            items: [...projects.values()],
            nextCursor: null,
            hasMore: false,
            storeEpoch: "epoch",
            projectionRevision: 0,
          })),
        createProject: (command) =>
          Effect.sync(() => {
            creates.push(command);
            const value = project(command.payload.projectId, command.payload.input.name ?? "");
            projects.set(value.id, value);
            return { value, apply: {} as never };
          }),
      },
      move: (command) =>
        Effect.gen(function* () {
          moves.push(command);
          if (failMove)
            return yield* new AgentRuntimeApplicationError({
              operation: "move-session",
              message: "Interrupted after Project creation",
            });
          session.projectId = command.projectId;
          return { sessionId: session.id, projectId: session.projectId };
        }),
    };
    return {
      input,
      creates,
      moves,
      session,
      failMove: (fail: boolean) => {
        failMove = fail;
      },
    };
  };

  it.effect(
    "turns an existing folder into a Project and retries without creating another Project",
    () =>
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const f = fixture(directory);
        f.failMove(true);
        assert.isTrue(yield* turnSessionFolderIntoProject(f.input).pipe(Effect.isFailure));
        f.failMove(false);
        const result = yield* turnSessionFolderIntoProject(f.input);
        assert.deepEqual(yield* turnSessionFolderIntoProject(f.input), result);
        assert.equal(f.creates.length, 1);
        assert.deepEqual(f.creates[0]?.payload, {
          projectId: result.projectId,
          input: { name: path.basename(directory), sources: [directory] },
        });
        assert.deepEqual(f.session.executionRef, { runtimeId: "runtime", threadId: "thread" });
      }),
  );

  it.effect("uses an existing execution cwd and rejects a source owned by another Project", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const legacy = fixture(directory, { legacy: true });
      yield* turnSessionFolderIntoProject({ ...legacy.input, name: "Research" });
      assert.deepEqual(legacy.creates[0]?.payload.input, {
        name: "Research",
        sources: [directory],
      });

      const occupied = fixture(directory, { owner: true });
      const result = yield* turnSessionFolderIntoProject(occupied.input).pipe(Effect.flip);
      assert.include(result.message, "already a source for Notes");
      assert.deepEqual(occupied.creates, []);
      assert.deepEqual(occupied.moves, []);
    }),
  );
});

describe("ProjectArchiveBlockers", () => {
  it.effect(
    "Project archive sees child execution and background work without opening any transcript",
    () => {
      const activity = vi.fn(() =>
        Effect.succeed({
          snapshotSequence: 12,
          executionHandoff: { threadId: "root:moving", operationId: "move" },
          run: { threadId: "child:active", runId: "run:child", status: "running" },
          runtimeRequest: { threadId: "child:waiting", requestId: "request" },
          nativeBackground: { threadId: "root:completed", taskId: "native:background" },
        }),
      );
      const terminals = vi.fn(() =>
        Effect.succeed([{ sessionId: "terminal", projectSessionId: "session" }]),
      );
      const root = {
        id: "session",
        executionRef: { runtimeId: "runtime", threadId: "root" },
      } as ProjectSessionSummary;
      return Effect.gen(function* () {
        const blockers = yield* ProjectArchiveBlockers;
        assert.deepEqual(yield* blockers.list({ project: { id: "project" }, sessions: [root] }), [
          { kind: "terminal", terminalSessionId: "terminal", projectSessionId: "session" },
          { kind: "execution-handoff", threadId: "root:moving", operationId: "move" },
          { kind: "active-turn", threadId: "child:active", label: null },
          { kind: "pending-request", threadId: "child:waiting", label: null },
          {
            kind: "background-process",
            threadId: "root:completed",
            processId: "native:background",
            label: null,
          },
        ]);
        assert.deepEqual(activity.mock.calls, [["project"]]);
        assert.deepEqual(terminals.mock.calls, [
          [{ conversationIds: new Set(["root"]), projectSessionIds: new Set(["session"]) }],
        ]);
      }).pipe(
        Effect.provide(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentRuntimeApplication, {
                  projectActivity: activity,
                } as unknown as AgentRuntimeApplication["Service"]),
                Layer.succeed(TerminalSessions, {
                  listLiveSessionsForOwners: terminals,
                } as unknown as TerminalSessions["Service"]),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect(
    "an unavailable execution owner fails closed, including Projects with no visible Sessions",
    () => {
      const unavailable = new AgentRuntimeApplicationError({
        operation: "project-activity",
        message: "Runtime unavailable",
      });
      return Effect.gen(function* () {
        const blockers = yield* ProjectArchiveBlockers;
        const result = yield* blockers
          .list({ project: { id: "project" }, sessions: [] })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure, unavailable);
      }).pipe(
        Effect.provide(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(AgentRuntimeApplication, {
                  projectActivity: () => Effect.fail(unavailable),
                } as unknown as AgentRuntimeApplication["Service"]),
                Layer.succeed(TerminalSessions, {
                  listLiveSessionsForOwners: () => Effect.succeed([]),
                } as unknown as TerminalSessions["Service"]),
              ),
            ),
          ),
        ),
      );
    },
  );
});

describe("SessionSnoozeScenario", () => {
  test("the chat status scenario retains pending and overdue snoozes across Core restart", async () => {
    await withCoreScenario({ scenarioId: SIDEBAR_CHAT_STATUS_SCENARIO_ID }, async (scenario) => {
      const facts = requireSidebarChatStatusFacts(scenario.facts);
      const pending = await scenario.seed.readSession(facts.sessionIdsByKey.pendingSnooze);
      const due = await scenario.seed.readSession(facts.sessionIdsByKey.dueSnooze);
      expect(Date.parse(pending!.snoozedUntil!)).toBeGreaterThan(Date.now());
      expect(Date.parse(due!.snoozedUntil!)).toBeLessThanOrEqual(Date.now());
      await scenario.withStoppedCore(async () => {});
      expect((await scenario.seed.readSession(pending!.id))?.snoozedUntil).toBe(
        pending!.snoozedUntil,
      );
      expect((await scenario.seed.readSession(due!.id))?.snoozedUntil).toBe(due!.snoozedUntil);
    });
  });
});
