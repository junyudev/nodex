import { getIntl } from "@/lib/i18n";
import type {
  AgentManagementFailure,
  AgentManagementResult,
} from "../../shared/agent-management-result";
import { readableIpcError } from "./ipc-error-message";

/** A rejected IPC call loses its structure; only its readable reason remains. */
export const describeAgentManagementCause = (cause: unknown): string =>
  readableIpcError(
    cause,
    getIntl().formatMessage({
      id: "acpAgents.acpAgentModel.somethingWentWrong",
      defaultMessage: "Something went wrong.",
    }),
  );

/** Transport and programming failures become an `invalid_request` failure with their message. */
const transportFailure = (cause: unknown): AgentManagementFailure => ({
  reason: "invalid_request",
  message: describeAgentManagementCause(cause),
});

export const settleAgentManagement = async <Value>(
  run: () => Promise<AgentManagementResult<Value>>,
): Promise<AgentManagementResult<Value>> => {
  try {
    return await run();
  } catch (cause) {
    return { ok: false, error: transportFailure(cause) };
  }
};
