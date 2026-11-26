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
import { projectForFolder, resolveFolderPlacement } from "./FolderPlacement";
import {
  previewChatSort,
  sortChatsIntoProjects,
  turnSessionFolderIntoProject,
} from "./SessionFolderProjects";
import * as Layer from "effect/Layer";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { ProjectArchiveBlockers, live } from "./ProjectArchiveBlockers";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import {
  SIDEBAR_CHAT_STATUS_SCENARIO_ID,
  requireSidebarChatStatusFacts,
} from "../../../scripts/scenarios/scenarios/sidebar-chat-status";

const places = {
  home: "/home/person",
  nodexHome: "/home/person/.nodex",
  temporary: ["/scratch", tmpdir()],
};
const mainRoot = "/code/widgets";
const repository = {
  root: mainRoot,
  commonDirectory: `${mainRoot}/.git`,
  remoteUrl: "git@github.com:team/widgets.git",
};
const folder = (path: string, identity: typeof repository | null = null) => ({
  path,
  repository: identity,
});
const projectSource = (source: ReturnType<typeof folder>, active = true) => ({
  folder: source,
  active,
  projectId: "widgets-project",
  name: "Widgets",
});

describe("folder placement", () => {
  test("routes exact folders, contained folders, and linked worktrees to the active source", () => {
    const main = projectSource(folder(mainRoot, repository));
    const worktree = folder("/linked/widgets", { ...repository, root: "/linked/widgets" });
    const linked = projectSource(worktree);
    const expected = { kind: "project", projectId: main.projectId, name: main.name };
    for (const [cwd, source] of [
      [folder(mainRoot), main],
      [folder(`${mainRoot}/src`), main],
      [worktree, main],
      [folder(mainRoot, repository), linked],
    ] as const) {
      expect(resolveFolderPlacement(cwd, [source], places)).toEqual(expected);
    }
    expect(resolveFolderPlacement(folder("/code/widgets-backup"), [main], places).kind).toBe(
      "new-project",
    );
    const separateClone = {
      ...repository,
      root: "/code/clone",
      commonDirectory: "/code/clone/.git",
    };
    expect(resolveFolderPlacement(folder("/code/clone", separateClone), [main], places).kind).toBe(
      "new-project",
    );
  });

  test("uses the main checkout and recognizable repository name for a new Project", () => {
    const expected = {
      kind: "new-project",
      projectId: projectForFolder(mainRoot),
      root: mainRoot,
      name: "team/widgets",
    };
    expect(resolveFolderPlacement(folder("/linked/widgets/src", repository), [], places)).toEqual(
      expected,
    );
    expect(resolveFolderPlacement(folder(mainRoot, repository), [], places)).toEqual(expected);
    expect(resolveFolderPlacement(folder("/code/notes"), [], places)).toEqual({
      kind: "new-project",
      projectId: projectForFolder("/code/notes"),
      root: "/code/notes",
      name: "notes",
    });
  });

  test("keeps excluded folders and archived owners in Chats", () => {
    for (const cwd of [
      "/scratch/draft",
      "/home/person",
      "/home/person/Downloads/example",
      "/home/person/.codex/worktrees/example",
      "/home/person/.claude/projects",
      "/home/person/.gemini/antigravity",
      "/home/person/.nodex/tasks/example",
    ]) {
      expect(resolveFolderPlacement(folder(cwd), [], places)).toEqual({ kind: "chats" });
    }
    const archived = projectSource(folder(mainRoot, repository), false);
    expect(
      resolveFolderPlacement(folder("/linked/worktree", repository), [archived], places),
    ).toEqual({ kind: "chats" });
    expect(
      resolveFolderPlacement(folder("/scratch/draft"), [projectSource(folder("/scratch"))], places)
        .kind,
    ).toBe("project");
    expect(resolveFolderPlacement(null, [], places)).toEqual({ kind: "missing" });
  });
});

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
      places,
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

  it.effect("uses existing execution folders and places chats in an existing Project", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const legacy = fixture(directory, { legacy: true });
      yield* turnSessionFolderIntoProject({ ...legacy.input, name: "Research" });
      assert.deepEqual(legacy.creates[0]?.payload.input, {
        name: "Research",
        sources: [directory],
      });

      const occupied = fixture(directory, { owner: true });
      assert.deepEqual(yield* turnSessionFolderIntoProject(occupied.input), {
        projectId: "existing",
      });
      assert.deepEqual(occupied.creates, []);
      assert.equal(occupied.moves[0]?.projectId, "existing");
    }),
  );

  it.effect("sorts only the chats in the confirmed plan and uses the ordinary move", () =>
    Effect.gen(function* () {
      const directory = yield* tempDirectory;
      const f = fixture(directory, { owner: true });
      const input = {
        ...f.input,
        projects: {
          ...f.input.projects,
          listProjectSessionSummaryWindow: () =>
            Effect.sync(() => ({
              items: f.session.projectId === null ? [f.session as ProjectSessionSummary] : [],
              totalCount: f.session.projectId === null ? 1 : 0,
              nextCursor: null,
              hasMore: false,
              projectionRevision: 0,
            })),
        },
      };
      const preview = yield* previewChatSort(input);
      assert.deepEqual(preview.destinations, [
        { placement: { kind: "project", projectId: "existing", name: "Notes" }, count: 1 },
      ]);
      const result = yield* sortChatsIntoProjects(input, preview.planId);
      assert.deepEqual(result, { moved: 1, skipped: 0 });
      assert.equal(f.session.projectId, "existing");
      assert.deepEqual(f.creates, []);
      assert.isTrue(yield* sortChatsIntoProjects(input, preview.planId).pipe(Effect.isFailure));
      assert.equal(f.moves.length, 1);
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
