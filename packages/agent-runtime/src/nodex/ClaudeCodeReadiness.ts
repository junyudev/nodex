export interface ClaudeCodeReadiness {
  readonly status: "ready" | "installing" | "turned-off" | "failed";
  readonly message?: string;
}

/** Account authentication and the managed executable are independent. */
export function isolatedClaudeProbe(component?: ClaudeCodeReadiness) {
  const installed = component === undefined || component.status === "ready";
  return {
    installed,
    ...(component ? { installationSource: { kind: "component" as const, id: "claude-code" } } : {}),
    version: null,
    status: installed ? "ready" : component.status === "failed" ? "error" : "warning",
    auth: { status: "authenticated" },
    ...(component?.status === "installing" || component?.status === "turned-off"
      ? { componentUnavailableReason: component.status }
      : {}),
    ...(component?.message ? { message: component.message } : {}),
  } as const;
}
