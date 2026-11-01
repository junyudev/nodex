// @effect-diagnostics nodeBuiltinImport:off
import type { ProviderRequestKind, RuntimeMode } from "@t3tools/contracts";
import { NODEX_APP_MCP_SERVER } from "@t3tools/shared/nodexAppMcp";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface AcpRuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}

export type AcpPermissionDisposition = "allow" | "ask" | "deny";

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveAcpPermissionPath(path: string, cwd: string | null): string | undefined {
  const trimmed = path.trim();
  if (trimmed.length === 0) return undefined;
  if (NodePath.isAbsolute(trimmed)) return trimmed;
  if (cwd === null || cwd.trim().length === 0) return undefined;
  return `${cwd}${cwd.endsWith(NodePath.sep) ? "" : NodePath.sep}${trimmed}`;
}

function acpPathIsWithinRoot(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

// Canonicalize existing ancestors for symlink-aware checks of new paths; fail closed on errors.
function acpCanonicalPathForContainment(path: string): string | undefined {
  // realpath must resolve symlinks before ..; lexical normalization can hide traversal.
  let candidate = path;
  const missingSuffix: Array<string> = [];

  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    const parent = NodePath.dirname(candidate);
    if (parent === candidate) return undefined;
    missingSuffix.unshift(NodePath.basename(candidate));
    candidate = parent;
  }
}

interface AcpPolicyOperation {
  readonly kind: string | null | undefined;
  readonly locations: ReadonlyArray<{ readonly path: string }> | null | undefined;
}

function acpPolicyRequiresApproval(runtimePolicy: AcpRuntimePolicy): boolean {
  return runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode !== "full-access"
    : runtimePolicy.approvalPolicy !== "never";
}

function isAcpReadKind(toolKind: string): boolean {
  return toolKind === "read" || toolKind === "search" || toolKind === "think";
}

/** Reads follow explicit sandbox restrictions without asking. */
function acpReadDisposition(runtimePolicy: AcpRuntimePolicy): "allow" | "deny" {
  switch (unknownRecord(runtimePolicy.sandboxPolicy)?.type) {
    case undefined:
    case "readOnly":
    case "workspaceWrite":
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    default:
      return "deny";
  }
}

function acpWorkspaceWriteAllowsMutation(
  runtimePolicy: AcpRuntimePolicy,
  sandboxPolicy: Record<string, unknown>,
  locations: AcpPolicyOperation["locations"],
): boolean {
  const cwd =
    typeof runtimePolicy.cwd === "string" && runtimePolicy.cwd.trim().length > 0
      ? (resolveAcpPermissionPath(runtimePolicy.cwd, process.cwd()) ?? null)
      : null;
  const roots: Array<string> = [];
  if (cwd !== null) {
    const canonicalCwd = acpCanonicalPathForContainment(cwd);
    if (canonicalCwd !== undefined) roots.push(canonicalCwd);
  }
  const writableRoots = sandboxPolicy.writableRoots;
  if (Array.isArray(writableRoots)) {
    for (const writableRoot of writableRoots) {
      if (typeof writableRoot !== "string") continue;
      const resolved = resolveAcpPermissionPath(writableRoot, cwd);
      if (resolved === undefined) continue;
      const canonicalRoot = acpCanonicalPathForContainment(resolved);
      if (canonicalRoot !== undefined) roots.push(canonicalRoot);
    }
  }
  if (roots.length === 0) return false;

  if (locations === undefined || locations === null || locations.length === 0) {
    return false;
  }
  for (const location of locations) {
    const resolved = resolveAcpPermissionPath(location.path, cwd);
    const canonicalPath =
      resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
    if (
      canonicalPath === undefined ||
      !roots.some((root) => acpPathIsWithinRoot(canonicalPath, root))
    ) {
      return false;
    }
  }
  return true;
}

function acpOperationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  operation: AcpPolicyOperation,
): AcpPermissionDisposition {
  const toolKind = operation.kind ?? "other";
  if (isAcpReadKind(toolKind)) {
    return acpReadDisposition(runtimePolicy);
  }
  if (acpPolicyRequiresApproval(runtimePolicy)) {
    return "ask";
  }

  const sandboxPolicy = unknownRecord(runtimePolicy.sandboxPolicy);
  switch (sandboxPolicy?.type) {
    case "readOnly":
      return "deny";
    case "workspaceWrite":
      if (isAcpMutationKind(toolKind)) {
        return acpWorkspaceWriteAllowsMutation(
          runtimePolicy,
          sandboxPolicy ?? {},
          operation.locations,
        )
          ? "allow"
          : "deny";
      }
      return "deny";
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    case undefined:
      if (runtimePolicy.runtimeMode !== "full-access") return "deny";
      return "allow";
    default:
      return "deny";
  }
}

function isAcpMutationKind(toolKind: string): boolean {
  return toolKind === "edit" || toolKind === "delete" || toolKind === "move";
}

export function acpPermissionDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, {
    kind: request.toolCall.kind,
    locations: request.toolCall.locations,
  });
}

export function acpMcpToolApprovalElicitationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.CreateElicitationRequest,
  nativeRequestId?: string,
  hasSessionAppEndpoint = false,
): "ask" | "allow" | undefined {
  if (
    request.mode !== "form" ||
    (unknownRecord(request._meta)?.codex_approval_kind !== "mcp_tool_call" &&
      nativeRequestId?.startsWith("mcp_tool_call_approval_") !== true)
  ) {
    return undefined;
  }
  const meta = unknownRecord(request._meta);
  const server = meta?.server_name ?? meta?.serverName;
  if (hasSessionAppEndpoint && server === NODEX_APP_MCP_SERVER) return "allow";
  return acpPolicyRequiresApproval(runtimePolicy) ? "ask" : "allow";
}

export function acpClientExecuteDisposition(
  runtimePolicy: AcpRuntimePolicy,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "execute", locations: undefined });
}

export interface AcpExecutionContext {
  readonly command: string;
  readonly args?: ReadonlyArray<string> | null;
  readonly cwd?: string | null;
  readonly env?: ReadonlyArray<{ readonly name: string; readonly value: string }> | null;
}

/** Bind structured execution inputs when supplied; uncorrelated approvals cover one terminal only. */
export function acpApprovedExecution(
  rawInput: unknown,
  cwd: string | null,
): AcpExecutionContext | undefined {
  const input = unknownRecord(rawInput);
  if (!input) return undefined;
  const argv =
    Array.isArray(input.command) &&
    input.command.length > 0 &&
    input.command.every((part) => typeof part === "string")
      ? (input.command as string[])
      : undefined;
  const command = typeof input.command === "string" ? input.command : argv?.[0];
  if (command === undefined) return undefined;
  if (
    input.args != null &&
    (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === "string"))
  )
    return undefined;
  const env = input.env;
  if (
    env != null &&
    (!Array.isArray(env) ||
      !env.every(
        (entry) =>
          typeof unknownRecord(entry)?.name === "string" &&
          typeof unknownRecord(entry)?.value === "string",
      ))
  )
    return undefined;
  const args = input.args === undefined ? argv?.slice(1) : input.args;
  return {
    command,
    ...(args === undefined ? {} : { args: args as ReadonlyArray<string> | null }),
    cwd: typeof input.cwd === "string" ? input.cwd : cwd,
    ...(env === undefined ? {} : { env: env as NonNullable<AcpExecutionContext["env"]> | null }),
  };
}

export interface AcpApprovalGrantInput {
  readonly kind: ProviderRequestKind;
  readonly scope: "session" | "turn";
  readonly turnKey: string;
  readonly execution?: AcpExecutionContext;
}

export interface AcpClientPolicyGrants {
  readonly recordApproval: (input: AcpApprovalGrantInput) => void;
  readonly consumeExecute: (turnKey: string | null, execution?: AcpExecutionContext) => boolean;
}

const executionKey = (execution: AcpExecutionContext) =>
  JSON.stringify({
    command: execution.command,
    args: execution.args ?? [],
    cwd: execution.cwd ?? null,
    env: [...(execution.env ?? [])].sort(
      (a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value),
    ),
  });

/** Consumption is synchronous so concurrent terminal requests cannot reuse a once grant. */
export function makeAcpClientPolicyGrants(): AcpClientPolicyGrants {
  let sessionExecute = false;
  let onceGrants: AcpApprovalGrantInput[] = [];
  return {
    recordApproval: (input) => {
      if (input.kind !== "command") return;
      if (input.scope === "session") {
        sessionExecute = true;
        return;
      }
      onceGrants = [...onceGrants.filter((grant) => grant.turnKey === input.turnKey), input];
    },
    consumeExecute: (turnKey, execution) => {
      if (sessionExecute) return true;
      if (turnKey === null) return false;
      const index = onceGrants.findIndex(
        (grant) =>
          grant.turnKey === turnKey &&
          (grant.execution === undefined ||
            (execution !== undefined && executionKey(grant.execution) === executionKey(execution))),
      );
      if (index < 0) return false;
      onceGrants.splice(index, 1);
      return true;
    },
  };
}
