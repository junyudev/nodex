import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexReadThreadHistory } from "../codex-application/CodexReadThreadHistory";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { make, type SessionHistoryInput } from "./SessionObservation";

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
  backend: "codex" | "acp" | "claude" | null = "codex",
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
    });
    assert.deepStrictEqual((yield* acp.read(input, provenance)).history, {
      availability: "unavailable",
      reason: "backend_not_loaded",
    });
  }),
);

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
  "inspection distinguishes completed turns and uses durable native metadata without opening a backend",
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
      });
      const historical = yield* acp.inspect(input.sessionId, provenance);
      assert.strictEqual(historical.status, "idle");
      assert.strictEqual(historical.disposition, "complete");
      const draft = yield* setup({ read: () => Effect.succeed(snapshot(null)) });
      assert.strictEqual(
        (yield* draft.inspect(input.sessionId, provenance)).disposition,
        "complete",
      );
    }),
);

it.effect("inspection requires canonical Turn completion after native runtime becomes idle", () =>
  Effect.gen(function* () {
    let canonicalStatus: "active" | "idle" = "active";
    let turnStatus: "inProgress" | "completed" = "inProgress";
    const observation = yield* setup({
      read: () => Effect.succeed(snapshot()),
      directoryRead: () =>
        Effect.succeed({
          canonical: {
            threadRuntimeStatus: { type: canonicalStatus, activeFlags: [] },
            turns: [{ turnId: "turn:accepted", status: turnStatus }],
            requests: [],
          },
          snapshot: {
            statusType: "idle",
            statusActiveFlags: [],
            turns: [{ turnId: "turn:accepted", status: turnStatus }],
            requests: [],
          },
        } as never),
    });

    const active = yield* observation.inspect(input.sessionId, provenance);
    assert.strictEqual(active.status, "active");
    assert.strictEqual(active.disposition, "running");

    canonicalStatus = "idle";
    const nativeIdle = yield* observation.inspect(input.sessionId, provenance);
    assert.strictEqual(nativeIdle.status, "idle");
    assert.strictEqual(nativeIdle.disposition, "running");
    assert.notStrictEqual(active.cursor, nativeIdle.cursor);

    turnStatus = "completed";
    const completed = yield* observation.inspect(input.sessionId, provenance);
    assert.strictEqual(completed.status, "idle");
    assert.strictEqual(completed.disposition, "complete");
    assert.notStrictEqual(nativeIdle.cursor, completed.cursor);
  }),
);
