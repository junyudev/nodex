import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type {
  PluginMcpFailureCode,
  PluginMcpLease,
  PluginMcpLeaseScope,
  PluginMcpProject,
} from "../../../shared/agent-plugins/mcp-lease";
import type { AgentPluginMcpServer } from "../../../shared/agent-plugins/types";

export class PluginMcpFailure extends Data.TaggedError("PluginMcpFailure")<{
  readonly code: PluginMcpFailureCode;
}> {
  constructor(code: PluginMcpFailureCode) {
    super({ code });
  }
}

/** Published by the installation owner in commit order. Null withdraws the installation.
 * Package paths and server declarations are immutable within a generation.
 */
export interface PluginMcpInstallation {
  readonly generation: string;
  readonly packageRoot: string;
  readonly dataRoot: string;
  readonly activeProjects: readonly PluginMcpProject[];
  readonly servers: readonly AgentPluginMcpServer[];
}

export interface PluginMcpApprovalRequest {
  readonly scope: PluginMcpLeaseScope;
  readonly tool: Readonly<Tool>;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** Return ask when consent is still required. The port may wait for a decision and is interruptible. */
export type PluginMcpApproval = (
  request: PluginMcpApprovalRequest,
) => Effect.Effect<"allow" | "deny" | "ask">;

/** Resolve credentials for this scope and exact origin. Package header values never reach the port. */
export type PluginMcpSecrets = (request: {
  readonly scope: PluginMcpLeaseScope;
  readonly origin: string;
  readonly url: string;
  readonly declaredHeaderNames: readonly string[];
}) => Effect.Effect<Readonly<Record<string, string>>, PluginMcpFailure>;

export interface PluginMcpBrokerOptions {
  readonly resolveHeaders: PluginMcpSecrets;
  /** Trusted absolute directories for resolving bare commands. Never passed as child environment. */
  readonly executableSearchPath: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Additional connection attempts per live isolation key, after the first attempt. */
  readonly restartBudget?: number;
}

export interface PluginMcpLeaseOptions {
  readonly approval?: PluginMcpApproval;
  /** Maximum lifetime in milliseconds from issuance. Defaults to eight hours. */
  readonly maxLifetimeMs?: number;
}

export interface PluginMcpBrokerService {
  readonly publishInstallation: (
    installationId: string,
    installation: PluginMcpInstallation | null,
  ) => Effect.Effect<void>;
  readonly openLease: (
    scope: PluginMcpLeaseScope,
    options?: PluginMcpLeaseOptions,
  ) => Effect.Effect<PluginMcpLease, PluginMcpFailure>;
  readonly revokeLease: (leaseId: string) => Effect.Effect<void>;
  /** Trusted in-process callers supply their own scope as well as the credential. */
  readonly listTools: (
    scope: PluginMcpLeaseScope,
    lease: PluginMcpLease,
  ) => Effect.Effect<readonly Tool[], PluginMcpFailure>;
  readonly callTool: (
    scope: PluginMcpLeaseScope,
    lease: PluginMcpLease,
    name: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<CallToolResult, PluginMcpFailure>;
}

export class PluginMcpBroker extends Context.Service<PluginMcpBroker, PluginMcpBrokerService>()(
  "nodex/host/PluginMcpBroker",
) {}
