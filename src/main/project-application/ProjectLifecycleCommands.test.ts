import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";
import type { Project, ProjectArchiveBlocker, ProjectSessionSummary } from "../../shared/types";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { live as projectRuntimeLifecycleLive } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import type { ProjectWorkspaceApplyResult } from "../core-client/types";
import { ProjectArchiveBlockers } from "./ProjectArchiveBlockers";
import { ProjectLifecycleCommands, live } from "./ProjectLifecycleCommands";
import { ProjectWorkspace, type ProjectWorkspaceService } from "./ProjectWorkspace";

const makeProject = (lifecycle: Project["lifecycle"] = "active"): Project => ({
  id: "project-1",
  libraryId: "library-1",
  databaseId: "database-1",
  defaultDatabaseViewId: "view-1",
  lifecycle,
  bindingRevision: 1,
  name: "Alpha",
  description: "",
  appearance: DEFAULT_PROJECT_APPEARANCE,
  sources: [{ root: "/workspace/alpha", order: 0 }],
  primaryWorkspaceRoot: "/workspace/alpha",
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-01-01T00:00:00.000Z"),
  updated: new Date("2026-01-01T00:00:00.000Z"),
});

const session = (): ProjectSessionSummary => ({
  id: "session-1",
  projectId: "project-1",
  noThreadFallbackTitle: "Alpha chat",
  displayTitle: "Alpha chat",
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  thread: {
    sessionId: "session-1",
    projectId: "project-1",
    threadId: "thread-1",
    threadPreview: "",
    modelProvider: "openai",
    executionHostId: "local",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-01-01T00:00:00.000Z",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const committed = (commitSeq: number, operationId: string): ProjectWorkspaceApplyResult =>
  ({
    status: "committed",
    outcome: {
      affected_project_ids: ["project-1"],
      affected_session_ids: [],
      affected_thread_ids: [],
    },
    receipt: {
      operation_id: operationId,
      duplicate: false,
      affected_project_ids: ["project-1"],
      affected_session_ids: [],
    },
    commit: {
      store_epoch: "epoch:test",
      commit_seq: commitSeq,
      manifest_hash: "f".repeat(64),
    },
  }) as ProjectWorkspaceApplyResult;

const lifecycleCommand = (lifecycle: "active" | "archived") => ({
  operationId: `operation:${lifecycle}`,
  payload: { projectId: "project-1", lifecycle },
});

const testRuntime = (blockers: readonly (readonly ProjectArchiveBlocker[])[]) => {
  let project = makeProject();
  let blockerRead = 0;
  const setProjectLifecycle = vi.fn((command: ReturnType<typeof lifecycleCommand>) =>
    Effect.sync(() => {
      const lifecycle = command.payload.lifecycle;
      project = { ...project, lifecycle, bindingRevision: project.bindingRevision + 1 };
      return {
        value: project,
        apply: committed(project.bindingRevision, command.operationId),
      };
    }),
  );
  const closeBrowserConversation = vi.fn(() => Effect.void);
  const closeBrowserProject = vi.fn(() => Effect.void);
  const discardExitedSessionsForOwners = vi.fn(() => Effect.succeed<readonly string[]>([]));
  const workspace = ProjectWorkspace.of({
    getProject: () => Effect.succeed(project),
    listProjectSessionSummaryWindow: () =>
      Effect.succeed({
        items: [session()],
        nextCursor: null,
        hasMore: false,
        projectionRevision: 1,
      }),
    setProjectLifecycle,
  } as unknown as ProjectWorkspaceService);
  const lifecycleLayer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          BrowserApplication,
          BrowserApplication.of({
            closeConversation: closeBrowserConversation,
            localServers: { closeProject: closeBrowserProject },
          } as unknown as BrowserApplication["Service"]),
        ),
        Layer.succeed(
          ProjectArchiveBlockers,
          ProjectArchiveBlockers.of({
            list: () => Effect.succeed(blockers[blockerRead++] ?? []),
          }),
        ),
        projectRuntimeLifecycleLive,
        Layer.succeed(ProjectWorkspace, workspace),
        Layer.succeed(
          TerminalSessions,
          TerminalSessions.of({
            discardExitedSessionsForOwners,
          } as unknown as TerminalSessions["Service"]),
        ),
      ),
    ),
  );
  return {
    layer: lifecycleLayer,
    setProjectLifecycle,
    closeBrowserConversation,
    closeBrowserProject,
    discardExitedSessionsForOwners,
    blockerReads: () => blockerRead,
  };
};

it.effect("blocks archive before durable mutation or runtime cleanup", () => {
  const blocker: ProjectArchiveBlocker = {
    kind: "active-turn",
    threadId: "thread-1",
    label: "Alpha chat",
  };
  const runtime = testRuntime([[blocker]]);
  return Effect.gen(function* () {
    const commands = yield* ProjectLifecycleCommands;
    const result = yield* commands.setLifecycle(lifecycleCommand("archived"));
    assert.strictEqual(result.kind, "rejected");
    if (result.kind !== "rejected") return;
    assert.strictEqual(result.result.outcome.kind, "blocked");
    assert.strictEqual(runtime.setProjectLifecycle.mock.calls.length, 0);
    assert.strictEqual(runtime.closeBrowserConversation.mock.calls.length, 0);
    assert.strictEqual(runtime.closeBrowserProject.mock.calls.length, 0);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete ProjectLifecycleCommands application layer.
  }).pipe(Effect.provide(runtime.layer));
});

it.effect("rechecks blockers under the Project gate immediately before commit", () => {
  const blocker: ProjectArchiveBlocker = {
    kind: "pending-request",
    threadId: "thread-1",
    label: null,
  };
  const runtime = testRuntime([[], [blocker]]);
  return Effect.gen(function* () {
    const commands = yield* ProjectLifecycleCommands;
    const result = yield* commands.setLifecycle(lifecycleCommand("archived"));
    assert.strictEqual(result.kind, "rejected");
    if (result.kind !== "rejected") return;
    assert.strictEqual(result.result.outcome.kind, "blocked");
    assert.strictEqual(runtime.blockerReads(), 2);
    assert.strictEqual(runtime.setProjectLifecycle.mock.calls.length, 0);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete ProjectLifecycleCommands application layer.
  }).pipe(Effect.provide(runtime.layer));
});

it.effect("archives, cleans Project-owned runtimes, and restores through one command owner", () => {
  const runtime = testRuntime([[], []]);
  return Effect.gen(function* () {
    const commands = yield* ProjectLifecycleCommands;
    const archived = yield* commands.setLifecycle(lifecycleCommand("archived"));
    assert.strictEqual(archived.kind, "committed");
    if (archived.kind !== "committed") return;
    assert.deepStrictEqual(archived.result.value, {
      kind: "updated",
      project: { ...makeProject(), lifecycle: "archived", bindingRevision: 2 },
      changed: true,
    });
    assert.strictEqual(archived.result.apply.receipt.operation_id, "operation:archived");
    assert.strictEqual(runtime.closeBrowserConversation.mock.calls.length, 1);
    assert.strictEqual(runtime.closeBrowserProject.mock.calls.length, 1);
    assert.strictEqual(runtime.discardExitedSessionsForOwners.mock.calls.length, 1);

    const restored = yield* commands.setLifecycle(lifecycleCommand("active"));
    assert.strictEqual(restored.kind, "committed");
    if (restored.kind !== "committed") return;
    assert.strictEqual(restored.result.value.changed, true);
    assert.strictEqual(restored.result.value.project.lifecycle, "active");
    assert.strictEqual(runtime.setProjectLifecycle.mock.calls.length, 2);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete ProjectLifecycleCommands application layer.
  }).pipe(Effect.provide(runtime.layer));
});
