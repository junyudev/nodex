import type { AgentAcpFailure } from "./AcpManagementContract.ts";

// Exhaustiveness keeps the transport decoder aligned without importing engine schemas into Main.
const reasons = {
  agent_not_configured: true,
  agent_not_found: true,
  archive_invalid: true,
  authentication_failed: true,
  checksum_mismatch: true,
  download_failed: true,
  install_failed: true,
  instance_not_found: true,
  logout_unsupported: true,
  logout_failed: true,
  probe_failed: true,
  project_not_found: true,
  registry_unavailable: true,
  runner_unavailable: true,
  session_import_failed: true,
  session_delete_unsupported: true,
  session_delete_failed: true,
  session_list_unsupported: true,
  session_resume_unsupported: true,
  providers_unsupported: true,
  providers_list_failed: true,
  provider_configuration_failed: true,
  unsupported_distribution: true,
  unsupported_platform: true,
  busy: true,
  configuration_pending: true,
  disabled: true,
  invalid_request: true,
  operation_expired: true,
} satisfies Record<AgentAcpFailure["reason"], true>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length <= maximum;
const texts = (value: unknown, maximumItems: number, maximumLength: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= maximumItems &&
  value.every((item) => text(item, maximumLength));
const reason = (value: unknown): value is AgentAcpFailure["reason"] =>
  typeof value === "string" && Object.hasOwn(reasons, value);
type AuthMethod = NonNullable<AgentAcpFailure["authMethods"]>[number];

function decodeMethod(value: unknown): AuthMethod | null {
  if (
    !record(value) ||
    !text(value.id, 256) ||
    !text(value.name, 256) ||
    !(value.description === null || text(value.description, 1_024)) ||
    !(value.type === "agent" || value.type === "env_var" || value.type === "terminal")
  )
    return null;
  if (value.envVarNames !== undefined && !texts(value.envVarNames, 16, 256)) return null;
  if (value.link !== undefined && !text(value.link, 2_048)) return null;
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    type: value.type,
    ...(value.envVarNames === undefined ? {} : { envVarNames: value.envVarNames }),
    ...(value.link === undefined ? {} : { link: value.link }),
  };
}

function decodeAction(value: unknown): AgentAcpFailure["authAction"] | null {
  if (
    !record(value) ||
    !text(value.elicitationId, 256) ||
    !text(value.url, 2_048) ||
    !text(value.message, 1_024)
  )
    return null;
  if (value.createdAt !== undefined && !text(value.createdAt, 128)) return null;
  if (value.expiresAt !== undefined && !text(value.expiresAt, 128)) return null;
  return {
    elicitationId: value.elicitationId,
    url: value.url,
    message: value.message,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  };
}

/** Decode only public recovery fields. Nested causes and terminal command lines never cross this boundary. */
export function decodeAgentAcpFailure(value: unknown): AgentAcpFailure | null {
  if (!record(value) || !reason(value.reason) || !text(value.message, 4_096)) return null;
  const authMethods: AuthMethod[] = [];
  if (value.authMethods !== undefined) {
    if (!Array.isArray(value.authMethods) || value.authMethods.length > 32) return null;
    for (const candidate of value.authMethods) {
      const method = decodeMethod(candidate);
      if (method === null) return null;
      authMethods.push(method);
    }
  }
  const authAction = value.authAction === undefined ? undefined : decodeAction(value.authAction);
  if (authAction === null) return null;
  if (value.affectedThreadIds !== undefined && !texts(value.affectedThreadIds, 10_000, 1_024))
    return null;
  return {
    reason: value.reason,
    message: value.message,
    ...(value.authMethods === undefined ? {} : { authMethods }),
    ...(authAction === undefined ? {} : { authAction }),
    ...(value.affectedThreadIds === undefined
      ? {}
      : { affectedThreadIds: value.affectedThreadIds }),
  };
}
