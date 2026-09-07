import * as Effect from "effect/Effect";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const runtime = yield* WorkspaceDependencyRuntime;
  const turns = yield* CodexTurnAuthority;
  return Effect.fn("WorkspaceDependencyAppTools.execute")(function* (input: AppToolInvocation) {
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    if (Object.keys(input.arguments).length !== 0) return toolFailure("invalid_arguments");
    const authority = yield* turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!authority) return toolFailure("authority_unavailable");
    const result = yield* runtime.read;
    return input.caller.isActive() ? toolSuccess(result) : toolFailure("call_withdrawn");
  });
});
