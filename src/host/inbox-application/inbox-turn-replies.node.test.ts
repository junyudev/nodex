import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostInvocation } from "../HostInvocation";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { DEFAULT_INBOX_SETTINGS, LIBRARY_INBOX } from "../../shared/inbox";
import { inboxOverRealCore } from "./InboxApplication.test-support";
import type { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
type Runtime = AgentRuntimeApplication["Service"];
it.effect("answers the active chat's exact pending question without creating intake", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let selected = "";
      const f = yield* inboxOverRealCore(Effect.void, undefined, () => DEFAULT_INBOX_SETTINGS, {
        control: ({ sessionId }) => {
          selected = sessionId;
          return Effect.succeed({
            threadId: "thread:new",
            snapshot: {
              projection: {
                runtimeRequests: [
                  {
                    id: "request",
                    nodeId: "node",
                    kind: "user_input",
                    status: "pending",
                    responseCapability: { type: "live" },
                  },
                ],
                nodes: [{ id: "node", threadId: "thread:new", runId: "run" }],
              },
            },
          } as unknown as Effect.Success<ReturnType<Runtime["control"]>>);
        },
        observeSessionMetadata: () =>
          Effect.succeed({
            details: {
              pendingRequests: [
                {
                  id: "request",
                  kind: "question",
                  questions: [
                    {
                      id: "choice",
                      question: "Which approach?",
                      options: [{ label: "Small change" }],
                      allowCustomAnswer: false,
                    },
                  ],
                },
              ],
            },
          } as unknown as NonNullable<
            Effect.Success<ReturnType<Runtime["observeSessionMetadata"]>>
          >),
      });
      const page = createUuidV7();
      const chat = createUuidV7();
      yield* Effect.promise(async () => {
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "create_page_for",
            for: { kind: "project", project_id: f.projectId },
            page_id: page,
            document_id: createUuidV7(),
            title: "Choose approach",
          },
        });
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "create_agent_runtime_session",
            session_id: chat,
            project_id: f.projectId,
            title: "Current work",
            initial_page_ids: [page],
            runtime_id: "test-runtime",
            runtime_thread_id: "thread:new",
            launch_request_id: createUuidV7(),
          },
        });
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "record_session_execution",
            session_id: chat,
            expected_revision: 0,
            observation: {
              state: "waiting",
              runId: "run",
              runStartedAt: 0,
              pendingRequestIds: ["request"],
              pendingRequests: [
                {
                  id: "request",
                  kind: "question",
                  question: "Which approach?",
                  options: ["Small change"],
                },
              ],
              queue: null,
              terminalStatus: null,
              personStopped: false,
              stalled: false,
              progressFingerprint: "question",
              progressSince: 0,
            },
          },
        });
      });
      const item = (yield* f.inbox.window({ scope: LIBRARY_INBOX, filter: "inbox" })).items.find(
        (row) => row.pageId === page,
      );
      assert.equal(item?.rowKind, "turn");
      const input = {
        operationId: createBoundedOperationId("test.turn.reply"),
        pageId: createUuidV7(),
        documentId: createUuidV7(),
        issuedAt: Date.now(),
        storeEpoch: (yield* f.inbox.summary({ scope: LIBRARY_INBOX })).storeEpoch,
        scope: LIBRARY_INBOX,
        replyToPageId: page,
        turnEpisode: item!.turn!.turn.episode,
        body: "Small change",
      };
      yield* f.inbox.send(input);
      assert.equal(selected, chat);
      const outbox = yield* f.inbox.outbox(10);
      const delivery = outbox.find((work) => work.session_id === chat);
      assert.equal(delivery?.final_text, "Small change");
      assert.deepEqual(delivery?.question_response, {
        request_id: "request",
        run_id: "run",
        question_id: "choice",
        answer: "Small change",
      });
      assert.isFalse(
        (yield* f.inbox.window({ scope: LIBRARY_INBOX, filter: "inbox" })).items.some(
          (row) => row.pageId === input.pageId,
        ),
      );
      yield* Effect.flip(
        f.inbox.send({
          ...input,
          operationId: createBoundedOperationId("test.turn.ambiguous"),
          body: "A different choice",
        }),
      );
      assert.equal(
        (yield* f.inbox.outbox(10)).filter((work) => work.session_id === chat).length,
        1,
      );
    }),
  ),
);

it.effect("sends a Member to the connected desktop before replying to a native Turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* inboxOverRealCore();
      const page = createUuidV7();
      const chat = createUuidV7();
      const thread = createUuidV7();
      yield* Effect.promise(async () => {
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "create_page_for",
            for: { kind: "project", project_id: f.projectId },
            page_id: page,
            document_id: createUuidV7(),
            title: "Native work",
          },
        });
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "create_session",
            session_id: chat,
            project_id: f.projectId,
            title: "Native chat",
            initial_page_ids: [page],
          },
        });
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "upsert_thread",
            thread_id: thread,
            patch: {
              project_id: f.projectId,
              thread_name: "Native chat",
              created_at: 1,
              updated_at: 1,
              linked_at: new Date().toISOString(),
            },
          },
        });
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "mutate_session",
            session_id: chat,
            intent: { kind: "link_thread", thread_id: thread, expected_project_id: f.projectId },
          },
        });
        await f.client.workspaceApply({
          operationId: createUuidV7(),
          intent: {
            kind: "record_session_execution",
            session_id: chat,
            expected_revision: 0,
            observation: {
              state: "waiting",
              runId: "run",
              runStartedAt: 0,
              pendingRequestIds: ["question"],
              pendingRequests: [{ id: "question", kind: "question", question: "Continue?" }],
              queue: null,
              terminalStatus: null,
              personStopped: false,
              stalled: false,
              progressFingerprint: "question",
              progressSince: 0,
            },
          },
        });
      });
      const row = yield* f.inbox.entry(page);
      assert.equal(row?.rowKind, "turn");
      const member = Effect.provideService(HostInvocation, "member-proof");
      const reason = "Continue this chat on its desktop.";
      const destination = yield* f.inbox.replyDestination(page, "Continue").pipe(member);
      assert.deepEqual(destination, {
        kind: "unavailable",
        chat: { sessionId: chat, title: "Native chat" },
        reason,
      });
      const error = yield* f.inbox
        .send({
          operationId: createBoundedOperationId("test.native.turn.reply"),
          pageId: createUuidV7(),
          documentId: createUuidV7(),
          issuedAt: Date.now(),
          storeEpoch: f.identity.storeEpoch,
          scope: LIBRARY_INBOX,
          replyToPageId: page,
          turnEpisode: row!.turn!.turn.episode,
          body: "Continue",
        })
        .pipe(member, Effect.flip);
      assert.equal(error.message, reason);
      assert.equal((yield* f.inbox.entry(page))?.turn?.turn.episode, row!.turn!.turn.episode);
    }),
  ),
);
