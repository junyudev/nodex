import { it, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createUuidV7 } from "../../shared/uuid-v7";
import { classifyCoreOperationFailure } from "../core-runtime/CoreRuntimeError";
import { fixture } from "./ChatSearch.test-support";

class ChatScenarioError extends Data.TaggedError("ChatScenarioError")<{
  readonly cause: unknown;
}> {}
const acquireScenario = Effect.acquireRelease(
  Effect.callback<
    { client: CoreScenarioContext["client"]; release: () => void; completed: Promise<void> },
    ChatScenarioError
  >((resume) => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = withCoreScenario(
      { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
      async ({ client }) => {
        resume(Effect.succeed({ client, release, completed }));
        await released;
      },
    );
    void completed.catch((cause) => resume(Effect.fail(new ChatScenarioError({ cause }))));
  }),
  ({ release, completed }) =>
    Effect.promise(() => {
      release();
      return completed;
    }),
);

it.effect(
  "finds older Core chats and includes archived roots when requested",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* acquireScenario;
        const ids: string[] = [];
        for (let index = 0; index < 250; index++) {
          const sessionId = createUuidV7();
          ids.push(sessionId);
          yield* Effect.promise(() =>
            client.workspaceApply({
              operationId: createUuidV7(),
              intent: {
                kind: "create_session",
                session_id: sessionId,
                project_id: null,
                title:
                  index === 0
                    ? "Oldest discoverable conversation"
                    : index === 1
                      ? "Archived conversation for restoration"
                      : `Conversation ${index}`,
                initial_page_ids: [],
              },
            }),
          );
        }
        const archived = ids[1]!;
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "mutate_session",
              session_id: archived,
              intent: { kind: "set_archived", archived: true },
            },
          }),
        );
        const runtime = createUuidV7();
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "create_agent_runtime_session",
              session_id: runtime,
              project_id: null,
              title: "Runtime unique title",
              initial_page_ids: [],
              runtime_id: "runtime",
              runtime_thread_id: "runtime-root",
              launch_request_id: createUuidV7(),
            },
          }),
        );
        const sideChat = createUuidV7();
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "create_agent_runtime_session",
              session_id: sideChat,
              project_id: null,
              title: "Hidden side conversation",
              initial_page_ids: [],
              runtime_id: "runtime",
              runtime_thread_id: "runtime-side",
              launch_request_id: createUuidV7(),
              side_chat_source_session_id: runtime,
            },
          }),
        );
        const native = ids[2]!;
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "mutate_session",
              session_id: native,
              intent: {
                kind: "link_thread",
                thread_id: "native-root",
                expected_project_id: null,
                thread_patch: {
                  backend_binding: { driver: "codex", instanceId: "codex" },
                  execution_host_id: "local",
                  thread_preview: "Native opening",
                  thread_name: "Native unique title",
                },
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "upsert_thread",
              thread_id: "native-child",
              patch: {
                backend_binding: { driver: "codex", instanceId: "codex" },
                execution_host_id: "local",
                parent_thread_id: "native-root",
                thread_name: "Hidden child conversation",
              },
            },
          }),
        );
        yield* Effect.promise(() =>
          client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "mutate_session",
              session_id: native,
              intent: { kind: "set_archived", archived: true },
            },
          }),
        );
        const { service } = fixture({
          read: (request) =>
            Effect.tryPromise({
              try: () => client.workspaceRead(request),
              catch: (cause) => classifyCoreOperationFailure("workspace.read", cause),
            }),
        });
        const search = yield* service;
        const oldest = yield* search.search({ query: "Oldest discoverable", limit: 10 });
        expect(oldest.complete).toBe(true);
        expect(oldest.matches.map(({ chat }) => chat.sessionId)).toEqual([ids[0]]);
        const bindings = yield* search.search({
          query: "unique title",
          limit: 10,
          startedOnly: true,
          includeArchived: true,
        });
        expect(new Set(bindings.matches.map(({ chat }) => chat.sessionId))).toEqual(
          new Set([runtime, native]),
        );
        expect((yield* search.search({ query: "Hidden", limit: 10 })).matches).toEqual([]);
        const archiveQuery = { query: "conversation for restoration", limit: 10 };
        expect((yield* search.search(archiveQuery)).matches).toEqual([]);
        const withArchive = yield* search.search({ ...archiveQuery, includeArchived: true });
        expect(withArchive.matches.map(({ chat }) => [chat.sessionId, chat.archived])).toEqual([
          [archived, true],
        ]);
        const archivedNative = yield* search.searchMessages({
          query: "Native unique",
          limit: 10,
          includeArchived: true,
          startedOnly: true,
        });
        expect(archivedNative.matches.map(({ chat }) => [chat.sessionId, chat.archived])).toEqual([
          [native, true],
        ]);
      }),
    ),
  60_000,
);
