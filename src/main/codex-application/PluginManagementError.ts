import * as Schema from "effect/Schema";
import type { PluginFailureCode, PluginFailure } from "../../shared/codex-plugin-management";
export class PluginManagementError extends Schema.TaggedError<PluginManagementError>()(
  "PluginManagementError",
  {
    code: Schema.Literals([
      "invalid_input",
      "project_unavailable",
      "host_unavailable",
      "unsupported",
      "auth_required",
      "account_changed",
      "policy_denied",
      "protected",
      "not_found",
      "inventory_unavailable",
      "config_conflict",
      "mutation_outcome_unknown",
      "service_unavailable",
    ]),
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}
export const pluginError = (code: PluginFailureCode, message: string, retryable = false) =>
  new PluginManagementError({ code, message, retryable });
export const pluginFailure = (error: PluginManagementError): PluginFailure => ({
  code: error.code,
  message: error.message,
  retryable: error.retryable,
});
