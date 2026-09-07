import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { AcpConversationSnapshot } from "../../shared/acp-conversation";
import { AgentBackendApplication } from "../agent-backend/AgentBackendApplication";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexReadThreadHistory } from "../codex-application/CodexReadThreadHistory";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { make, readAcpHistoryPage, type SessionHistoryInput } from "./SessionObservation";

const input: SessionHistoryInput = {
  sessionId: "session:a",
  turnLimit: 1,
  includeOutputs: false,
  maxOutputCharsPerItem: 8,
};
const provenance = {
  profile_id: "profile:a",
  authority: {
    thread_id: "thread:caller",
    turn_id: "turn:a",
    root_thread_id: "thread:caller",
    actor_project_id: "project:a",
    library_id: "library:a",
    store_epoch: "epoch:a",
    scope: "project",
    source: "project_turn",
  },
} as const;
const snapshot = (
  backend: "codex" | "acp" | null = "codex",
  projectId = "project:a",
): ProjectWorkspaceReadSnapshot =>
  ({
    value: {
      kind: "agent_session",
      session: {
        id: input.sessionId,
        project_id: projectId,
        display_title: "Title",
        archived: false,
        pinned: false,
      },
      thread: backend
        ? {
            thread_id: "thread:a",
            backend_binding: { kind: backend },
            status: { status_type: "idle", active_flags: [] },
          }
        : null,
    },
  }) as never;
const setup = (options: {
  read: CoreModules["Service"]["workspace"]["read"];
  codexRead?: CodexReadThreadHistory["Service"]["read"];
  acpRead?: AgentBackendApplication["Service"]["readAcpSession"];
  directoryRead?: CodexThreadDirectory["Service"]["resolve"];
}) =>
  make.pipe(
    Effect.provideService(CoreModules, { workspace: { read: options.read } } as never),
    Effect.provideService(CodexThreadDirectory, {
      resolve: options.directoryRead ?? (() => Effect.succeed(null)),
    } as never),
    Effect.provideService(CodexReadThreadHistory, {
      read: options.codexRead ?? (() => Effect.die("Codex history must not be read")),
    }),
    Effect.provideService(AgentBackendApplication, {
      readAcpSession: options.acpRead ?? (() => Effect.die("ACP history must not be read")),
    } as never),
  );

it.effect(
  "authorizes before history and discards it if Session ownership changes during the read",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let reads = 0;
      const observation = yield* setup({
        read: (request, _options, projectId) =>
          Effect.sync(() => {
            assert.deepStrictEqual(request, {
              kind: "agent_session",
              session_id: input.sessionId,
              provenance,
            });
            assert.strictEqual(projectId, "project:a");
            calls.push("authorize");
            return snapshot("codex", reads++ === 0 ? "project:a" : "project:other");
          }),
        codexRead: () =>
          Effect.sync(() => {
            calls.push("history");
            return {
              page: { nextCursor: null, hasMore: false, limit: 1, order: "newest_first" },
              turns: [{ text: "private history" }],
            } as never;
          }),
      });
      const failed = yield* observation.read(input, provenance).pipe(Effect.flip);
      assert.strictEqual(failed.reason, "authority_changed");
      assert.deepStrictEqual(calls, ["authorize", "history", "authorize"]);
      const denied = yield* setup({
        read: () =>
          Effect.fail(
            coreRuntimeError({ operation: "read", reason: "operation", retryable: false }),
          ),
      });
      assert.strictEqual(
        (yield* denied.read(input, provenance).pipe(Effect.flip)).reason,
        "authorization",
      );
    }),
);

it.effect("distinguishes empty drafts from unloaded ACP history without creating a backend", () =>
  Effect.gen(function* () {
    const draft = yield* setup({ read: () => Effect.succeed(snapshot(null)) });
    assert.deepStrictEqual((yield* draft.read(input, provenance)).history, {
      availability: "empty",
      turns: [],
    });
    const acp = yield* setup({
      read: () => Effect.succeed(snapshot("acp")),
      acpRead: () => Effect.succeed(null),
    });
    assert.deepStrictEqual((yield* acp.read(input, provenance)).history, {
      availability: "unavailable",
      reason: "backend_not_loaded",
    });
    const loaded = yield* setup({
      read: () => Effect.succeed(snapshot("acp")),
      acpRead: () =>
        Effect.succeed({
          snapshot: {
            backend: "acp",
            threadId: "thread:a",
            sessionId: "acp:a",
            revision: 1,
            status: "idle",
            error: null,
            turns: [],
          },
        } as never),
    });
    const loadedResult = yield* loaded.read(input, provenance);
    assert.strictEqual(loadedResult.backend, "acp");
    assert.deepInclude(loadedResult.history, { availability: "available", coverage: "retained" });
  }),
);

it("bounds ACP pages and outputs and rejects cursors after snapshot changes", () => {
  const acp: AcpConversationSnapshot = {
    backend: "acp",
    threadId: "thread:a",
    sessionId: "acp:a",
    status: "idle",
    error: null,
    revision: 4,
    turns: [1, 2].map((sequence) => ({
      sequence,
      clientUserMessageId: null,
      promptText: "Long prompt text",
      stopReason: "end_turn",
      updates: [
        {
          kind: "tool-call",
          key: "tool",
          toolCallId: "tool",
          title: "Read",
          name: null,
          toolKind: "read",
          status: "completed",
          detail: "Long output text",
          locations: [],
        },
      ],
    })),
  };
  const first = readAcpHistoryPage(acp, input)!;
  assert.deepStrictEqual(
    first.turns.map((turn) => turn.sequence),
    [2],
  );
  assert.strictEqual(first.turns[0]?.prompt, "Long pr…");
  assert.deepStrictEqual(first.turns[0]?.items, [
    { kind: "tool-call", id: "tool", title: "Read", status: "completed" },
  ]);
  const cursor = first.page.nextCursor!;
  const older = readAcpHistoryPage(acp, { ...input, cursor, includeOutputs: true })!;
  assert.deepStrictEqual(
    older.turns.map((turn) => turn.sequence),
    [1],
  );
  assert.deepStrictEqual(older.turns[0]?.items, [
    { kind: "tool-call", id: "tool", title: "Read", status: "completed", output: "Long ou…" },
  ]);
  assert.strictEqual(older.page.nextCursor, null);
  assert.strictEqual(readAcpHistoryPage({ ...acp, revision: 5 }, { ...input, cursor }), null);
  assert.strictEqual(readAcpHistoryPage(acp, { ...input, cursor: "acp:other:4:1" }), null);
});

it.effect(
  "lists discovery metadata without reading any transcript and preserves inherited placement",
  () =>
    Effect.gen(function* () {
      const observation = yield* setup({
        read: (request) => {
          assert.deepStrictEqual(request, {
            kind: "session_window",
            archived: true,
            window: { after: "cursor:a", first: 2 },
          });
          return Effect.succeed({
            value: {
              kind: "session_window",
              sessions: {
                items: [
                  {
                    task: {
                      session: {
                        id: "session:other",
                        project_id: "project:other",
                        display_title: "Other",
                        archived: true,
                        pinned: false,
                      },
                      thread: null,
                    },
                    project_name: "Other Project",
                    project_section_id: "section:a",
                    direct_section_id: null,
                    project_pinned: false,
                  },
                ],
                next_cursor: "cursor:b",
                authority: { projection_revision: 4 },
              },
            },
          } as never);
        },
      });
      const result = yield* observation.list({ archived: true, cursor: "cursor:a", limit: 2 });
      assert.strictEqual(result.nextCursor, "cursor:b");
      assert.strictEqual(result.projectionRevision, 4);
      assert.deepStrictEqual(result.sessions[0]?.placement, {
        kind: "section",
        source: "project",
        sectionId: "section:a",
      });
      assert.strictEqual(result.sessions[0]?.projectId, "project:other");
      assert.strictEqual(result.sessions[0]?.backend, null);
    }),
);

it.effect(
  "inspection distinguishes subsequent completed turns without reading history and reports unloaded ACP",
  () =>
    Effect.gen(function* () {
      let turnId = "turn:first";
      const observation = yield* setup({
        read: () => Effect.succeed(snapshot()),
        directoryRead: (request) => {
          assert.deepStrictEqual(request, { threadId: "thread:a", fidelity: "durable" });
          return Effect.succeed({
            snapshot: {
              statusType: "idle",
              statusActiveFlags: [],
              turns: [{ turnId, status: "completed" }],
              requests: [],
            },
          } as never);
        },
      });
      const first = yield* observation.inspect(input.sessionId, provenance);
      assert.strictEqual(first.disposition, "complete");
      turnId = "turn:second";
      const second = yield* observation.inspect(input.sessionId, provenance);
      assert.notStrictEqual(first.cursor, second.cursor);
      const stable = yield* observation.inspect(input.sessionId, provenance);
      assert.strictEqual(second.cursor, stable.cursor);
      const acp = yield* setup({
        read: () => Effect.succeed(snapshot("acp")),
        acpRead: () => Effect.succeed(null),
      });
      const unavailable = yield* acp.inspect(input.sessionId, provenance);
      assert.strictEqual(unavailable.disposition, "unavailable");
      const draft = yield* setup({ read: () => Effect.succeed(snapshot(null)) });
      assert.strictEqual(
        (yield* draft.inspect(input.sessionId, provenance)).disposition,
        "complete",
      );
    }),
);
