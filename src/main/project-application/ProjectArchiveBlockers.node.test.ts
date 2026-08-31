import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { ProjectSessionSummary } from "../../shared/types";
import { CodexBackgroundProcesses } from "../codex-application/CodexBackgroundProcesses";
import { CodexConversations } from "../codex-application/CodexConversations";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { ProjectArchiveBlockers, live } from "./ProjectArchiveBlockers";

const session = (
  sessionId: string,
  threadId: string,
  backendBinding: AgentBackendBinding,
  statusType: "active" | "idle",
): ProjectSessionSummary => ({
  id: sessionId,
  projectId: "project-1",
  noThreadFallbackTitle: threadId,
  displayTitle: threadId,
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  thread: {
    sessionId,
    projectId: "project-1",
    threadId,
    threadPreview: "",
    backendBinding,
    executionHostId: "local",
    statusType,
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-01-01T00:00:00.000Z",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it.effect("uses durable ACP activity without querying Codex-only runtime owners", () => {
  const readCodexActivity = vi.fn(() => ({ active: false, pending: false, label: null }));
  const listCodexBackgroundProcesses = vi.fn(() => Effect.succeed([]));
  const sessions = [
    session("session-codex", "thread-codex", { kind: "codex" }, "idle"),
    session(
      "session-acp",
      "thread-acp",
      {
        kind: "acp",
        agentDefinitionId: "claude-agent-acp",
        instanceConfigId: "claude-local",
      },
      "active",
    ),
  ];
  const layer = live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          CodexBackgroundProcesses,
          CodexBackgroundProcesses.of({
            list: listCodexBackgroundProcesses,
          } as unknown as CodexBackgroundProcesses["Service"]),
        ),
        Layer.succeed(
          CodexConversations,
          CodexConversations.of({
            activity: readCodexActivity,
          } as unknown as CodexConversations["Service"]),
        ),
        Layer.succeed(
          TerminalSessions,
          TerminalSessions.of({
            listLiveSessionsForOwners: () => Effect.succeed([]),
          } as unknown as TerminalSessions["Service"]),
        ),
      ),
    ),
  );

  return Effect.gen(function* () {
    const blockers = yield* ProjectArchiveBlockers;
    const result = yield* blockers.list({ sessions });
    assert.deepStrictEqual(result, [{ kind: "active-turn", threadId: "thread-acp", label: null }]);
    assert.deepStrictEqual(readCodexActivity.mock.calls, [["thread-codex"]]);
    assert.deepStrictEqual(listCodexBackgroundProcesses.mock.calls, [
      [{ threadId: "thread-codex" }],
    ]);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete blocker application layer.
  }).pipe(Effect.provide(layer));
});
