import * as Effect from "effect/Effect";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import { readSessionTerminalSchema } from "../../shared/nodex-app-tools/terminal-schema";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const workspace = yield* ProjectWorkspace;
  const turns = yield* CodexTurnAuthority;
  const terminals = yield* TerminalSessions;
  return Effect.fn("TerminalAppTools.read")(function* (input: AppToolInvocation) {
    const parsed = readSessionTerminalSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const capture = turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const authority = yield* capture;
    if (!authority) return toolFailure("authority_unavailable");
    const thread = yield* workspace
      .getThread(input.caller.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!thread || thread.executionHostId !== input.caller.hostId)
      return toolFailure("session_unavailable");
    const snapshots = yield* terminals.listSnapshotsForOwners({
      conversationIds: new Set([input.caller.threadId]),
      projectSessionIds: new Set(thread.sessionId ? [thread.sessionId] : []),
    });
    const current = yield* capture;
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    if (
      !current ||
      nodexAgentAuthorityFingerprint(current) !== nodexAgentAuthorityFingerprint(authority)
    )
      return toolFailure("authority_unavailable");
    if (!parsed.data.terminalId && snapshots.length > 1)
      return toolSuccess({
        status: "selection_required",
        candidates: snapshots.map((snapshot) => ({
          terminalId: snapshot.sessionId,
          title: snapshot.title,
          cwd: snapshot.cwd,
          exited: snapshot.exited,
        })),
      });
    const snapshot = parsed.data.terminalId
      ? snapshots.find((item) => item.sessionId === parsed.data.terminalId)
      : snapshots[0];
    if (!snapshot) return toolSuccess({ status: "unavailable" });
    return toolSuccess({
      status: "available",
      terminalId: snapshot.sessionId,
      sessionId: thread.sessionId,
      cwd: snapshot.cwd,
      shell: snapshot.shell,
      title: snapshot.title,
      buffer: snapshot.buffer.slice(-parsed.data.maxChars),
      truncated: snapshot.truncated || snapshot.buffer.length > parsed.data.maxChars,
      exited: snapshot.exited,
      exitCode: snapshot.exitCode,
    });
  });
});
