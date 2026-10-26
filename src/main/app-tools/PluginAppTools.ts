import { captureAppToolAuthority, type AppToolAuthorityCapture } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import { uninstallPluginSchema } from "../../shared/nodex-app-tools/plugin-schema";
import { PluginNativeOperations } from "../codex-application/PluginNativeOperations";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";

export const makeWithCapture = (capture: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const plugins = yield* PluginNativeOperations;
    const workspace = yield* ProjectWorkspace;
    return Effect.fn("PluginAppTools.uninstall")(function* (input: AppToolInvocation) {
      const parsed = uninstallPluginSchema.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const recapture = capture(input.caller);
      const authority = yield* recapture;
      if (!authority) return toolFailure("authority_unavailable");

      const calling = yield* resolveAppToolCallingSession(input.caller, workspace);
      if (!calling) return toolFailure("session_unavailable");
      return yield* plugins
        .uninstall({
          plugin: parsed.data.plugin,
          cwds: calling.cwd ? [calling.cwd] : [],
          isCurrent: Effect.gen(function* () {
            if (!input.caller.isActive()) return false;
            const current = yield* recapture;
            return (
              current !== null &&
              nodexAgentAuthorityFingerprint(current) ===
                nodexAgentAuthorityFingerprint(authority) &&
              input.caller.isActive()
            );
          }),
        })
        .pipe(
          Effect.map((result) =>
            result.status === "protected" ? toolFailure("protected_plugin") : toolSuccess(result),
          ),
          Effect.catch(() =>
            Effect.succeed(
              toolFailure(
                "plugin_outcome_unavailable",
                "Read the installed inventory before deciding whether to retry.",
              ),
            ),
          ),
        );
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
