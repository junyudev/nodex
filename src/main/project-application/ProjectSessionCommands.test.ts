import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import type { ProjectSession } from "../../shared/types";
import type { ProjectSessionDeleteCommandInput } from "../../shared/workspace-catalog-commands";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { CodexSidebarSectionSync } from "../codex-application/CodexSidebarSectionSync";
import { CodexThreadTitlePersistence } from "../codex-application/CodexThreadTitlePersistence";
import { ConversationCommands } from "../codex-application/ConversationCommands";
import type { ProjectWorkspaceApplyResult } from "../core-client/types";
import { ProjectSessionCommands, live } from "./ProjectSessionCommands";
import { ProjectWorkspace, type ProjectWorkspaceService } from "./ProjectWorkspace";

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
};

const applied = {
  status: "committed",
  outcome: {
    affected_project_ids: [],
    affected_session_ids: [session.id],
    affected_thread_ids: [],
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
  const reads = vi.fn(() => Effect.succeed(session));
  const mutation = (name: string) => (command: { readonly operationId: string }) =>
    Effect.sync(() => {
      events.push(`${name}:${command.operationId}`);
      return { value: session, apply: applied };
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
            set: ({ name }) => Effect.sync(() => (events.push(`title:${name}`), true)),
            setRequired: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          ConversationCommands,
          ConversationCommands.of({
            archive: (threadId: string) =>
              Effect.sync(() => (events.push(`archive:${threadId}`), true)),
            unarchive: (threadId: string) =>
              Effect.sync(() => (events.push(`unarchive:${threadId}`), null)),
          } as unknown as ConversationCommands["Service"]),
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
    yield* commands.rename({
      operationId: "operation:rename",
      payload: { sessionId: session.id, input: { title: "  New   title  " } },
    });
    const readsBeforeDelete = reads.mock.calls.length;
    yield* commands.delete({
      operationId: "operation:delete",
      payload: { sessionId: session.id },
    });
    assert.strictEqual(reads.mock.calls.length, readsBeforeDelete);
    yield* commands.archive({
      operationId: "operation:archive",
      payload: { sessionId: session.id },
    });
    yield* commands.unarchive({
      operationId: "operation:unarchive",
      payload: { sessionId: session.id },
    });
    yield* commands.setPinned({
      operationId: "operation:pinned",
      payload: { sessionId: session.id, pinned: true },
    });

    assert.deepStrictEqual(events, [
      "title:  New   title  ",
      "rename:operation:rename",
      "sections",
      "delete:operation:delete",
      `browser:${session.id}`,
      "sections",
      `archive:${session.thread?.threadId}`,
      "archive:operation:archive",
      "sections",
      `unarchive:${session.thread?.threadId}`,
      "unarchive:operation:unarchive",
      "sections",
      "pinned:operation:pinned",
      "sections",
    ]);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete ProjectSessionCommands layer.
  }).pipe(Effect.provide(layer));
});
