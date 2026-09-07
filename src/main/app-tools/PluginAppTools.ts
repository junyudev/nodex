import * as Effect from "effect/Effect";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import { uninstallPluginSchema } from "../../shared/nodex-app-tools/plugin-schema";
import { ComposerCatalog } from "../codex-application/ComposerCatalog";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const catalog = yield* ComposerCatalog;
  const workspace = yield* ProjectWorkspace;
  const turns = yield* CodexTurnAuthority;
  return Effect.fn("PluginAppTools.uninstall")(function* (input: AppToolInvocation) {
    const parsed = uninstallPluginSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const capture = turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const authority = yield* capture;
    if (!authority) return toolFailure("authority_unavailable");
    if (authority.readOnly) return toolFailure("read_only_turn");
    const thread = yield* workspace
      .getThread(input.caller.threadId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!thread || thread.executionHostId !== input.caller.hostId)
      return toolFailure("session_unavailable");
    return yield* catalog
      .uninstallPlugin({
        plugin: parsed.data.plugin,
        cwds: thread.cwd ? [thread.cwd] : [],
        isCurrent: Effect.gen(function* () {
          if (!input.caller.isActive()) return false;
          const current = yield* capture;
          return (
            current !== null &&
            nodexAgentAuthorityFingerprint(current) === nodexAgentAuthorityFingerprint(authority) &&
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
