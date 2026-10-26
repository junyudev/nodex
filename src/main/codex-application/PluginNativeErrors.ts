import * as Schema from "effect/Schema";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { pluginError } from "./PluginManagementError";

export function pluginNativeFailure(cause: { reason?: string; message?: string; cause?: unknown }) {
  if (
    cause.reason === "outcome-unknown" ||
    cause.reason === "timeout" ||
    cause.reason === "session-lost"
  )
    return pluginError(
      "mutation_outcome_unknown",
      "The plugin operation could not be confirmed. Refresh before trying again.",
    );
  if (Schema.is(CodexAppServerRequestError)(cause.cause) && cause.cause.code === -32601)
    return pluginError("unsupported", "This operation is unavailable on this agent.");
  return pluginError("service_unavailable", "The plugin operation could not be completed.", true);
}
