import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import type { ProjectSession } from "../../shared/types";
import type { ProjectSessionDeleteCommandInput } from "../../shared/workspace-catalog-commands";
import { AcpBackendSessionManager } from "../agent-backend/acp/AcpBackendSessionManager";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { CodexSidebarSectionSync } from "../codex-application/CodexSidebarSectionSync";
import { CodexThreadTitlePersistence } from "../codex-application/CodexThreadTitlePersistence";
import { ConversationCommands } from "../codex-application/ConversationCommands";
import { CodexConversationArchiveError } from "../codex-application/CodexConversationArchive";
import type { ProjectWorkspaceApplyResult } from "../core-client/types";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { ProjectSessionCommands, live } from "./ProjectSessionCommands";
import {
  ProjectWorkspace,
  ProjectWorkspaceError,
  type ProjectWorkspaceService,
} from "./ProjectWorkspace";

const session: ProjectSession = {
  id: "session:one",
  projectId: "project:one",
  noThreadFallbackTitle: "Before",
  displayTitle: "Before",
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  thread: {
    sessionId: "session:one",
    projectId: "project:one",
    threadId: "thread:one",
    threadPreview: "",
    backendBinding: { kind: "codex" },
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
};

const applied = {
  status: "committed",
  outcome: {
    affected_project_ids: [],
    affected_session_ids: [session.id],
    affected_thread_ids: [session.thread!.threadId],
  },
  receipt: {
    operation_id: "operation:test",
    duplicate: false,
    affected_project_ids: [],
    affected_session_ids: [session.id],
  },
  commit: {
    store_epoch: "epoch:test",
    commit_seq: 7,
    manifest_hash: "f".repeat(64),
  },
} as ProjectWorkspaceApplyResult;

it.effect("owns Session title, browser, archive, and Section orchestration", () => {
  const events: string[] = [];
  const mutationCallers: Array<{ name: string; authority: unknown }> = [];
  const backendCallers: unknown[] = [];
  let backendUnavailable = false;
  let barrier: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | null = null;
  const reads = vi.fn(() => Effect.succeed(session));
  const mutation = (name: string) => (command: { readonly operationId: string }) =>
    Effect.gen(function* () {
      if (command.operationId === "operation:denied")
        return yield* new ProjectWorkspaceError({
          operation: name,
          cause: new Error("Permission denied"),
        });
      mutationCallers.push({ name, authority: yield* CoreApplicationAgent });
      events.push(`${name}:${command.operationId}`);
      return {
        value: {
          ...session,
          archived: name === "archive" && command.operationId !== "operation:superseded",
        },
        apply: applied,
      };
    });
  const workspace = ProjectWorkspace.of({
    getProjectSession: reads,
    renameProjectSession: mutation("rename"),
    deleteProjectSession: (command: ProjectSessionDeleteCommandInput) =>
      Effect.sync(() => {
        events.push(`delete:${command.operationId}`);
        return { value: true, apply: applied };
      }),
    archiveProjectSession: mutation("archive"),
    unarchiveProjectSession: mutation("unarchive"),
    setProjectSessionPinned: mutation("pinned"),
  } as unknown as ProjectWorkspaceService);
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectWorkspace, workspace),
        Layer.succeed(
          BrowserApplication,
          BrowserApplication.of({
            closeConversation: (sessionId: string) =>
              Effect.sync(() => events.push(`browser:${sessionId}`)).pipe(
                Effect.andThen(Effect.die("browser cleanup unavailable")),
              ),
          } as unknown as BrowserApplication["Service"]),
        ),
        Layer.succeed(
          CodexThreadTitlePersistence,
          CodexThreadTitlePersistence.of({
            set: () => Effect.die("Session rename must use the committed Core title"),
            setRequired: () => Effect.die("unused"),
            syncCommittedTitle: (threadId) =>
              Effect.sync(() => {
                events.push(`title:${threadId}`);
              }),
          }),
        ),
        Layer.succeed(
          ConversationCommands,
          ConversationCommands.of({
            archive: (threadId: string) =>
              Effect.gen(function* () {
                events.push(`archive:${threadId}`);
                backendCallers.push(yield* CoreApplicationAgent);
                if (backendUnavailable)
                  return yield* new CodexConversationArchiveError({
                    operation: "archive",
                    threadId,
                    cause: new Error("Backend unavailable"),
                  });
                if (barrier) {
                  yield* Deferred.succeed(barrier.entered, undefined);
                  yield* Deferred.await(barrier.release);
                }
                return true;
              }),
            unarchive: (threadId: string) =>
              Effect.sync(() => (events.push(`unarchive:${threadId}`), null)),
          } as unknown as ConversationCommands["Service"]),
        ),
        Layer.succeed(
          AcpBackendSessionManager,
          AcpBackendSessionManager.of({
            close: () => Effect.void,
          } as unknown as AcpBackendSessionManager["Service"]),
        ),
        Layer.succeed(
          CodexSidebarSectionSync,
          CodexSidebarSectionSync.of({
            request: () => Effect.sync(() => events.push("sections")),
            syncHost: () => Effect.die("unused"),
            syncAll: () => Effect.die("unused"),
          }),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const commands = yield* ProjectSessionCommands;
    const denied = yield* commands
      .rename({
        operationId: "operation:denied",
        payload: { sessionId: session.id, input: { title: "Rejected title" } },
      })
      .pipe(Effect.flip);
    assert.strictEqual(denied.operation, "rename-session");
    const deniedArchive = yield* commands
      .archive({ operationId: "operation:denied", payload: { sessionId: session.id } })
      .pipe(Effect.flip);
    assert.strictEqual(deniedArchive.operation, "archive-session");
    assert.deepStrictEqual(events, []);
    yield* commands.rename({
      operationId: "operation:rename",
      payload: { sessionId: session.id, input: { title: "  New   title  " } },
    });
    const readsBeforeDelete = reads.mock.calls.length;
    yield* commands.delete({
      operationId: "operation:delete",
      payload: { sessionId: session.id },
    });
    assert.strictEqual(reads.mock.calls.length, readsBeforeDelete + 1);
    const caller = {
      profile_id: "profile:test",
      authority: {
        thread_id: "thread:caller",
        turn_id: "turn:caller",
        root_thread_id: "thread:caller",
        actor_project_id: "project:one",
        library_id: "library:test",
        store_epoch: "epoch:test",
        scope: "project",
        source: "project_turn",
      },
    } as const;
    yield* commands
      .archive({
        operationId: "operation:archive",
        payload: { sessionId: session.id },
      })
      .pipe(Effect.provideService(CoreApplicationAgent, caller));
    assert.deepStrictEqual(
      mutationCallers.find((item) => item.name === "archive")?.authority,
      caller,
    );
    assert.deepStrictEqual(backendCallers, [null]);
    assert.strictEqual(yield* CoreApplicationAgent, null);
    yield* commands.unarchive({
      operationId: "operation:unarchive",
      payload: { sessionId: session.id },
    });
    yield* commands.setPinned({
      operationId: "operation:pinned",
      payload: { sessionId: session.id, pinned: true },
    });

    assert.deepStrictEqual(events, [
      "rename:operation:rename",
      `title:${session.thread?.threadId}`,
      "sections",
      "delete:operation:delete",
      `browser:${session.id}`,
      "sections",
      "archive:operation:archive",
      `archive:${session.thread?.threadId}`,
      "sections",
      "unarchive:operation:unarchive",
      `unarchive:${session.thread?.threadId}`,
      "sections",
      "pinned:operation:pinned",
      "sections",
    ]);
    events.length = 0;
    barrier = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    const archiving = yield* commands
      .archive({ operationId: "operation:blocked", payload: { sessionId: session.id } })
      .pipe(Effect.forkChild);
    yield* Deferred.await(barrier.entered);
    const restoring = yield* commands
      .unarchive({ operationId: "operation:following", payload: { sessionId: session.id } })
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepStrictEqual(events, [
      "archive:operation:blocked",
      `archive:${session.thread?.threadId}`,
    ]);
    yield* Deferred.succeed(barrier.release, undefined);
    yield* Fiber.join(archiving);
    yield* Fiber.join(restoring);
    assert.deepStrictEqual(events, [
      "archive:operation:blocked",
      `archive:${session.thread?.threadId}`,
      "sections",
      "unarchive:operation:following",
      `unarchive:${session.thread?.threadId}`,
      "sections",
    ]);
    backendUnavailable = true;
    const synchronizationFailure = yield* commands
      .archive({ operationId: "operation:retry", payload: { sessionId: session.id } })
      .pipe(Effect.flip);
    assert.strictEqual(synchronizationFailure.committedOperationId, "operation:retry");
    backendUnavailable = false;
    yield* commands.archive({ operationId: "operation:retry", payload: { sessionId: session.id } });
    const backendCallsBeforeReplay = backendCallers.length;
    const superseded = yield* commands.archive({
      operationId: "operation:superseded",
      payload: { sessionId: session.id },
    });
    assert.strictEqual(superseded.value.archived, false);
    assert.strictEqual(backendCallers.length, backendCallsBeforeReplay);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete ProjectSessionCommands layer.
  }).pipe(Effect.provide(layer));
});

it.effect("keeps ACP Session lifecycle inside Core and the ACP runtime owner", () => {
  const events: string[] = [];
  const acpSession: ProjectSession = {
    ...session,
    thread: {
      ...session.thread!,
      backendBinding: {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-main",
      },
    },
  };
  const mutation = (name: string) => (command: { readonly operationId: string }) =>
    Effect.sync(() => {
      events.push(`${name}:${command.operationId}`);
      return { value: { ...acpSession, archived: name === "archive" }, apply: applied };
    });
  const workspace = ProjectWorkspace.of({
    getProjectSession: () => Effect.succeed(acpSession),
    renameProjectSession: mutation("rename"),
    archiveProjectSession: mutation("archive"),
    unarchiveProjectSession: mutation("unarchive"),
    deleteProjectSession: (command: ProjectSessionDeleteCommandInput) =>
      Effect.sync(() => {
        events.push(`delete:${command.operationId}`);
        return { value: true, apply: applied };
      }),
  } as unknown as ProjectWorkspaceService);
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectWorkspace, workspace),
        Layer.succeed(
          AcpBackendSessionManager,
          AcpBackendSessionManager.of({
            close: (threadId: string) => Effect.sync(() => events.push(`close:${threadId}`)),
          } as unknown as AcpBackendSessionManager["Service"]),
        ),
        Layer.succeed(
          BrowserApplication,
          BrowserApplication.of({
            closeConversation: () => Effect.void,
          } as unknown as BrowserApplication["Service"]),
        ),
        Layer.succeed(
          CodexThreadTitlePersistence,
          CodexThreadTitlePersistence.of({
            set: () => Effect.die("ACP rename must not reach Codex"),
          } as unknown as CodexThreadTitlePersistence["Service"]),
        ),
        Layer.succeed(
          ConversationCommands,
          ConversationCommands.of({
            archive: () => Effect.die("ACP archive must not reach Codex"),
            unarchive: () => Effect.die("ACP unarchive must not reach Codex"),
          } as unknown as ConversationCommands["Service"]),
        ),
        Layer.succeed(
          CodexSidebarSectionSync,
          CodexSidebarSectionSync.of({
            request: () => Effect.sync(() => events.push("sections")),
          } as unknown as CodexSidebarSectionSync["Service"]),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const commands = yield* ProjectSessionCommands;
    yield* commands.rename({
      operationId: "operation:rename",
      payload: { sessionId: acpSession.id, input: { title: "ACP title" } },
    });
    yield* commands.archive({
      operationId: "operation:archive",
      payload: { sessionId: acpSession.id },
    });
    yield* commands.unarchive({
      operationId: "operation:unarchive",
      payload: { sessionId: acpSession.id },
    });
    yield* commands.delete({
      operationId: "operation:delete",
      payload: { sessionId: acpSession.id },
    });

    assert.deepStrictEqual(events, [
      "rename:operation:rename",
      "sections",
      "archive:operation:archive",
      `close:${acpSession.thread?.threadId}`,
      "sections",
      "unarchive:operation:unarchive",
      "sections",
      `close:${acpSession.thread?.threadId}`,
      "delete:operation:delete",
      "sections",
    ]);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete ProjectSessionCommands layer.
  }).pipe(Effect.provide(layer));
});
