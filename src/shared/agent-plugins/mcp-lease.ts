export type PluginMcpPrincipal =
  | { readonly kind: "agent-session"; readonly id: string }
  | { readonly kind: "interface-view"; readonly id: string };

export interface PluginMcpProject {
  readonly spaceId: string;
  readonly projectId: string;
}

export interface PluginMcpLeaseScope {
  readonly installationId: string;
  readonly generation: string;
  readonly serverKey: string;
  readonly project: PluginMcpProject;
  readonly principal: PluginMcpPrincipal;
}

/** Keep the bearer in trusted delivery code. The URL alone conveys no authority. */
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
  | "unknown_tool"
  | "approval_denied"
  | "approval_required";
