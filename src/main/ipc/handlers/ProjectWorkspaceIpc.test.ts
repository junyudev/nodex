import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { vi } from "vite-plus/test";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import type { Project, ProjectUpdateCommandInput } from "../../../shared/types";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexProjectSessionFork } from "../../codex-application/CodexProjectSessionFork";
import { CodexSidebarSectionSync } from "../../codex-application/CodexSidebarSectionSync";
import { CoreModuleResponseError } from "../../core-client/core-client";
import type { ProjectWorkspaceApplyResult } from "../../core-client/types";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ProjectLifecycleCommands } from "../../project-application/ProjectLifecycleCommands";
import { ProjectSessionCommands } from "../../project-application/ProjectSessionCommands";
import {
  ProjectWorkspace,
  ProjectWorkspaceError,
  type ProjectWorkspaceService,
} from "../../project-application/ProjectWorkspace";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ProjectWorkspaceIpc";

vi.mock("../../platform/electron/TrustedRendererSender", () => ({
  requireTrustedAppRendererSender: () => undefined,
}));

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

const rendererEvent = (id: number): IpcMainInvokeEvent => {
  const frame = { url: "app://-/index.html" };
  return {
    sender: { getType: () => "window", id, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
};

const project: Project = {
  id: "project:one",
  libraryId: "library:one",
  databaseId: "database:one",
  defaultDatabaseViewId: "view:one",
  lifecycle: "active",
  bindingRevision: 2,
  name: "Renamed",
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [],
  primaryWorkspaceRoot: null,
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-01-01T00:00:00.000Z"),
  updated: new Date("2026-01-01T00:00:01.000Z"),
};

const applied = {
  status: "committed",
  outcome: {
    affected_project_ids: [project.id],
    affected_session_ids: [],
    affected_thread_ids: [],
  },
  receipt: {
    operation_id: "operation:test",
    duplicate: false,
    affected_project_ids: [project.id],
    affected_session_ids: [],
  },
  commit: {
    store_epoch: "epoch:test",
    commit_seq: 17,
    manifest_hash: "f".repeat(64),
  },
} as Extract<ProjectWorkspaceApplyResult, { readonly status: "committed" }>;

it.effect("owns Project and Project Session ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    });
    const updateInputs: ProjectUpdateCommandInput[] = [];
    const workspace = ProjectWorkspace.of({
      updateProject: (input: ProjectUpdateCommandInput) => {
        if (input.projectId === "project:missing") {
          return Effect.fail(
            new ProjectWorkspaceError({
              operation: "project.read",
              cause: new CoreModuleResponseError({
                code: "not_found",
                message: "Project not found",
                retryable: false,
                recovery: { kind: "none" },
              }),
            }),
          );
        }
        return Effect.sync(() => {
          updateInputs.push(input);
          return { value: project, apply: applied };
        });
      },
    } as unknown as ProjectWorkspaceService);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProjectWorkspace, workspace),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(
              CodexProjectSessionFork,
              CodexProjectSessionFork.of({ fork: () => Effect.die("unused") }),
            ),
            Layer.succeed(
              CodexSidebarSectionSync,
              CodexSidebarSectionSync.of({
                request: () => Effect.void,
                syncHost: () => Effect.die("unused"),
                syncAll: () => Effect.succeed([]),
              }),
            ),
            mainConfigLayer(),
            Layer.succeed(
              ProjectLifecycleCommands,
              ProjectLifecycleCommands.of({ setLifecycle: () => Effect.die("unused") }),
            ),
            Layer.succeed(
              ProjectSessionCommands,
              ProjectSessionCommands.of({
                rename: () => Effect.die("unused"),
                delete: () => Effect.die("unused"),
                archive: () => Effect.die("unused"),
                unarchive: () => Effect.die("unused"),
                setPinned: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(ElectronDesktop, { dialog: {} } as unknown as ElectronDesktop["Service"]),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.strictEqual(handlers.size, 43);
    assert.isTrue(handlers.has("projects:create"));
    assert.isTrue(handlers.has("projects:update"));
    assert.isTrue(handlers.has("project-sessions:fork"));
    assert.isTrue(handlers.has("project-session-threads:detach"));
    assert.isTrue(handlers.has("page-chats:activity-summaries"));
    assert.isTrue(handlers.has("page-chats:list"));
    assert.isTrue(handlers.has("page-chats:link"));
    assert.isTrue(handlers.has("page-chats:unlink"));

    const input = {
      operationId: createBoundedOperationId("workspace.project.rename", 1_800_000_000_000),
      projectId: project.id,
      updates: { name: project.name, expectedBindingRevision: project.bindingRevision },
    } satisfies ProjectUpdateCommandInput;
    const result = yield* handlers.get("projects:update")!(rendererEvent(17), input);
    assert.deepEqual(updateInputs, [input]);
    assert.deepEqual(result, {
      ok: true,
      value: project,
      localCommit: {
        status: "committed",
        commit: applied.commit,
        delivery: null,
      },
    });

    const missing = yield* handlers.get("projects:update")!(rendererEvent(17), {
      ...input,
      projectId: "project:missing",
    });
    assert.deepEqual(missing, {
      ok: false,
      error: {
        code: "not_found",
        message: "Project not found",
        retryable: false,
        recovery: { kind: "none" },
      },
    });

    const invalid = yield* Effect.exit(
      handlers.get("projects:update")!(rendererEvent(17), {
        ...input,
        operationId: "operation:legacy",
      }).pipe(Effect.asVoid),
    );
    assert.isTrue(Exit.isFailure(invalid));
    assert.strictEqual(updateInputs.length, 1);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
