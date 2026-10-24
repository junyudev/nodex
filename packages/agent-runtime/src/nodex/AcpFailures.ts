import { AcpRegistryOperationError, AcpRegistryOperationErrorReason } from "@t3tools/contracts";
import { AcpRegistryError } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as Schema from "effect/Schema";
import type { AgentAcpFailure } from "./AcpManagementContract.ts";

export class AcpManagementError extends Schema.TaggedError<AcpManagementError>()(
  "AcpManagementError",
  {
    reason: Schema.Literals([
      ...AcpRegistryOperationErrorReason.literals,
      "configuration_pending",
      "disabled",
      "invalid_request",
      "operation_expired",
    ]),
    message: Schema.String,
    affectedThreadIds: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {}

const messages: Partial<Record<AgentAcpFailure["reason"], string>> = {
  busy: "This Agent installation is in use. Retry after setup finishes.",
  authentication_failed: "Sign in to this Agent, then check the connection again.",
  registry_unavailable: "The Agent catalog is unavailable. Retry when it is reachable.",
  runner_unavailable: "Install the required package runner before installing this Agent.",
  unsupported_platform: "This Agent has no distribution for this platform.",
  unsupported_distribution: "Choose another distribution for this Agent.",
  checksum_mismatch: "The download did not match its published checksum. Retry the installation.",
  archive_invalid: "The Agent archive could not be safely installed.",
  download_failed: "The Agent download failed. Retry the installation.",
  install_failed: "The Agent installation did not finish. Retry the installation.",
  session_list_unsupported: "This Agent does not support native conversation discovery.",
  session_resume_unsupported: "This Agent cannot reconnect to native conversations.",
  providers_unsupported: "This Agent does not support configuring model services.",
};

/** Preserve recovery data while keeping CLI stderr and nested causes out of public responses. */
export function acpFailure(error: unknown): AgentAcpFailure {
  if (Schema.is(AcpManagementError)(error)) {
    return {
      reason: error.reason,
      message: error.message,
      ...(error.affectedThreadIds ? { affectedThreadIds: error.affectedThreadIds } : {}),
    };
  }
  if (Schema.is(AcpRegistryOperationError)(error)) {
    return {
      reason: error.reason,
      message:
        messages[error.reason] ??
        "The Agent could not complete this operation. Check its configuration and retry.",
      ...(error.authMethods
        ? { authMethods: error.authMethods.map(({ command: _command, ...method }) => method) }
        : {}),
      ...(error.authAction ? { authAction: error.authAction } : {}),
    };
  }
  if (Schema.is(AcpRegistryError)(error)) {
    return {
      reason: error.reason,
      message:
        messages[error.reason] ??
        "The Agent catalog operation failed. Retry after checking the configuration.",
    };
  }
  return {
    reason: "invalid_request",
    message: "The Agent could not complete this request. Refresh its state and retry.",
  };
}
