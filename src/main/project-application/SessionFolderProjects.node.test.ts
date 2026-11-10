import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { Project, ProjectSession } from "../../shared/types";
import type { ProjectCreateCommandInput } from "../../shared/workspace-catalog-commands";
import {
  AgentRuntimeApplicationError,
  type AgentRuntimeApplication,
} from "../agent-runtime/AgentRuntimeApplication";
import { turnSessionFolderIntoProject } from "./SessionFolderProjects";

const tempDirectory = Effect.acquireRelease(
  Effect.promise(async () => realpath(await mkdtemp(path.join(tmpdir(), "nodex-folder-project-")))),
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
    assert.deepEqual(legacy.creates[0]?.payload.input, { name: "Research", sources: [directory] });

    const occupied = fixture(directory, { owner: true });
    const result = yield* turnSessionFolderIntoProject(occupied.input).pipe(Effect.flip);
    assert.include(result.message, "already a source for Notes");
    assert.deepEqual(occupied.creates, []);
    assert.deepEqual(occupied.moves, []);
  }),
);
