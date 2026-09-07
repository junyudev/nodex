import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { TerminalSessionSnapshot } from "../../shared/types";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./TerminalAppTools";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: 1,
  readOnly: true,
  scope: "project",
  source: "project_turn",
};
const input: AppToolInvocation = {
  name: "read_session_terminal",
  arguments: {},
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};

it.effect(
  "selects exact attached terminals and rechecks authority before returning their bounded output",
  () =>
    Effect.gen(function* () {
      let revoke = false;
      let stale = false;
      const execute = yield* make.pipe(
        Effect.provideService(CodexTurnAuthority, {
          capture: () => Effect.sync(() => (stale ? null : authority)),
        } as unknown as CodexTurnAuthority["Service"]),
        Effect.provideService(ProjectWorkspace, {
          getThread: () => Effect.succeed({ sessionId: "session", executionHostId: "local" }),
        } as unknown as ProjectWorkspace["Service"]),
        Effect.provideService(TerminalSessions, {
          listSnapshotsForOwners: (
            owners: Parameters<TerminalSessions["Service"]["listSnapshotsForOwners"]>[0],
          ) =>
            Effect.sync(() => {
              assert.deepStrictEqual([...owners.conversationIds], ["thread"]);
              assert.deepStrictEqual([...owners.projectSessionIds], ["session"]);
              stale = revoke;
              return ["first", "second"].map(
                (sessionId) =>
                  ({
                    sessionId,
                    buffer: "hello world",
                    cwd: "/workspace",
                    shell: "zsh",
                    title: sessionId,
                    exited: sessionId === "first",
                    exitCode: 0,
                    truncated: false,
                  }) as TerminalSessionSnapshot,
              );
            }),
        } as unknown as TerminalSessions["Service"]),
      );
      assert.strictEqual((yield* execute(input)).structuredContent?.status, "selection_required");
      assert.deepStrictEqual(
        (yield* execute({ ...input, arguments: { terminalId: "first", maxChars: 5 } }))
          .structuredContent,
        {
          status: "available",
          terminalId: "first",
          sessionId: "session",
          cwd: "/workspace",
          shell: "zsh",
          title: "first",
          buffer: "world",
          truncated: true,
          exited: true,
          exitCode: 0,
        },
      );
      assert.deepStrictEqual(
        (yield* execute({ ...input, arguments: { terminalId: "other-session-terminal" } }))
          .structuredContent,
        { status: "unavailable" },
      );
      revoke = true;
      assert.deepStrictEqual((yield* execute(input)).structuredContent, {
        error: { code: "authority_unavailable" },
      });
    }),
);
