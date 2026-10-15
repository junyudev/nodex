import { captureAppToolAuthority, type AppToolAuthorityCapture } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const makeWithCapture = (capture: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const runtime = yield* WorkspaceDependencyRuntime;
    return Effect.fn("WorkspaceDependencyAppTools.execute")(function* (input: AppToolInvocation) {
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      if (Object.keys(input.arguments).length !== 0) return toolFailure("invalid_arguments");
      const authority = yield* capture(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      const result = yield* runtime.read;
      return input.caller.isActive() ? toolSuccess(result) : toolFailure("call_withdrawn");
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
