import type {
  PluginAgentSupport,
  PluginOutsideCodexLimitation,
  PluginProjectScope,
} from "../../../../shared/agent-plugins/session-plugins";

const OTHER_AGENTS = "Codex, Claude Code and ACP agents";

function describeLimitation(limitation: PluginOutsideCodexLimitation): string {
  switch (limitation.kind) {
    case "mcp-server-needs-sign-in":
      return `${limitation.serverKey} (needs sign-in)`;
    case "connected-app":
      return limitation.name;
    case "hooks":
      return "hooks";
  }
}

const KIND_PHRASES = {
  "mcp-server-needs-sign-in": "servers that need a sign-in",
  "connected-app": "connected apps",
  hooks: "hooks",
} as const satisfies Record<PluginOutsideCodexLimitation["kind"], string>;

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases.join("");
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

/**
 * Which Agents can use a plugin, and what stays in Codex, in one or two short lines. "items"
 * names each limited part, for a review without per-item marks; "kinds" summarizes them where
 * each part carries its own mark.
 */
export function describeAgentSupport(
  support: PluginAgentSupport,
  detail: "items" | "kinds" = "items",
): {
  readonly agents: string;
  readonly codexOnly: string | null;
} {
  if (support.outsideCodex === "none") return { agents: "Codex only", codexOnly: null };
  if (support.limitations.length === 0) return { agents: OTHER_AGENTS, codexOnly: null };
  if (detail === "items")
    return {
      agents: OTHER_AGENTS,
      codexOnly: `Only in Codex: ${support.limitations.map(describeLimitation).join(", ")}`,
    };
  const kinds = [...new Set(support.limitations.map(({ kind }) => KIND_PHRASES[kind]))];
  const sentence = joinPhrases(kinds);
  return {
    agents: OTHER_AGENTS,
    codexOnly: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} work only in Codex`,
  };
}

/** Whether a plugin MCP server works only in Codex. */
export function isCodexOnlyServer(support: PluginAgentSupport, serverKey: string): boolean {
  return (
    support.outsideCodex === "none" ||
    support.limitations.some(
      (limitation) =>
        limitation.kind === "mcp-server-needs-sign-in" && limitation.serverKey === serverKey,
    )
  );
}

/** The scope trigger's label: "All projects", a Project's name, or a count. */
export function describeProjectScope(
  scope: PluginProjectScope,
  projects: readonly { readonly id: string; readonly name: string }[],
): string {
  if (scope.kind === "all") return "All projects";
  const names = scope.projectIds.flatMap(
    (id) => projects.find((project) => project.id === id)?.name ?? [],
  );
  const count = scope.projectIds.length;
  if (count === 1 && names.length === 1) return names[0]!;
  return `${count} ${count === 1 ? "project" : "projects"}`;
}

/** Toggles one Project in a scope. The last chosen Project stays chosen; "All projects" widens it. */
export function toggleProjectInScope(
  scope: PluginProjectScope,
  projectId: string,
): PluginProjectScope {
  if (scope.kind === "all") return { kind: "projects", projectIds: [projectId] };
  const chosen = scope.projectIds.includes(projectId);
  if (chosen && scope.projectIds.length === 1) return scope;
  return {
    kind: "projects",
    projectIds: chosen
      ? scope.projectIds.filter((id) => id !== projectId)
      : [...scope.projectIds, projectId],
  };
}
