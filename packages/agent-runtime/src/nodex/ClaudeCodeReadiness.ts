export interface ClaudeCodeReadiness {
  readonly status: "ready" | "installing" | "turned-off" | "failed";
  readonly message?: string;
}

/** Account authentication and the managed executable are independent. */
export function isolatedClaudeProbe(component?: ClaudeCodeReadiness) {
  const installed = component === undefined || component.status === "ready";
  return {
    installed,
    ...(component ? { requiredComponent: "claude-code" as const } : {}),
    version: null,
    status: installed ? "ready" : component.status === "failed" ? "error" : "warning",
    auth: { status: "authenticated" },
    ...(component?.message ? { message: component.message } : {}),
  } as const;
}
