import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type {
  PluginMcpFailureCode,
  PluginMcpLease,
  PluginMcpLeaseScope,
} from "../../../shared/agent-plugins/mcp-lease";
import type { AgentPluginMcpServer, AgentPluginSkill } from "../../../shared/agent-plugins/types";

export class PluginMcpFailure extends Data.TaggedError("PluginMcpFailure")<{
  readonly code: PluginMcpFailureCode;
}> {
  constructor(code: PluginMcpFailureCode) {
    super({ code });
  }
}

/** Package paths and server declarations resolved by the attachment owner. */
export interface PluginMcpInstallation {
  readonly generation: string;
  readonly packageRoot: string;
  readonly dataRoot: string;
  readonly servers: readonly AgentPluginMcpServer[];
  readonly skills?: readonly AgentPluginSkill[];
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

/** Resolve credentials for this scope and exact origin. The Host supplies the headers for that server. */
export type PluginMcpSecrets = (request: {
  readonly scope: PluginMcpLeaseScope;
  readonly origin: string;
  readonly url: string;
  readonly declaredHeaderNames: readonly string[];
  readonly declaredHeaders: Readonly<Record<string, string>>;
}) => Effect.Effect<Readonly<Record<string, string>>, PluginMcpFailure>;

export interface PluginMcpBrokerOptions {
  readonly resolveHeaders: PluginMcpSecrets;
  /** Trusted absolute directories for resolving bare commands. Never passed as child environment. */
  readonly executableSearchPath: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Maximum time to drain requests before forcing upstream shutdown. Defaults to 35 seconds. */
  readonly shutdownGraceMs?: number;
  /** Additional connection attempts per live isolation key, after the first attempt. */
  readonly restartBudget?: number;
}

export interface PluginMcpLeaseOptions {
  readonly approval?: PluginMcpApproval;
  readonly authorize?: Effect.Effect<boolean>;
  /** Bind a client that pools HTTP sockets to one MCP session issued on its first connection. */
  readonly httpBinding?: "mcp-session";
  /** Maximum lifetime in milliseconds from issuance. Defaults to eight hours. */
  readonly maxLifetimeMs?: number;
}

export interface PluginMcpBrokerService {
  readonly openLease: (
    scope: PluginMcpLeaseScope,
    source: PluginMcpInstallation,
    options?: PluginMcpLeaseOptions,
  ) => Effect.Effect<PluginMcpLease, PluginMcpFailure>;
  readonly openSkillCatalog: (
    source: import("./skill-catalog").SkillCatalogSource,
    options?: Pick<PluginMcpLeaseOptions, "authorize">,
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
