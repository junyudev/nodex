export type PluginMcpPrincipal =
  | { readonly kind: "agent-session"; readonly id: string }
  | { readonly kind: "interface-view"; readonly id: string; readonly sessionId?: string };

export interface PluginMcpProject {
  readonly spaceId: string;
  readonly projectId: string | null;
}

export interface PluginMcpLeaseScope {
  readonly pluginId: string;
  readonly generation: string;
  readonly serverKey: string;
  readonly project: PluginMcpProject;
  readonly principal: PluginMcpPrincipal;
}

/** The first authenticated HTTP connection binds the bearer. Keep it in trusted delivery code. */
export interface PluginMcpLease {
  readonly id: string;
  readonly url: string;
  readonly bearerToken: string;
}

export type PluginMcpFailureCode =
  | "invalid_lease"
  | "lease_revoked"
  | "server_inactive"
  | "broker_closed"
  | "listener_unavailable"
  | "invalid_configuration"
  | "upstream_unavailable"
  | "restart_budget_exhausted"
  | "timeout"
  | "shutdown_timeout"
  | "unknown_tool"
  | "approval_denied"
  | "approval_required";
