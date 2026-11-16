import { defineMessage, getIntl, type MessageDescriptor, type IntlShape } from "@/lib/i18n";
import type {
  PluginAgentSupport,
  PluginOutsideCodexLimitation,
  PluginProjectScope,
} from "../../../../shared/agent-plugins/session-plugins";

const OTHER_AGENTS = defineMessage({
  id: "plugins.pluginAgentSupport.supportedAgents",
  defaultMessage: "Codex, Claude Code and ACP agents",
});

function describeLimitation(limitation: PluginOutsideCodexLimitation): string {
  switch (limitation.kind) {
    case "mcp-server-needs-sign-in":
      return getIntl().formatMessage(
        {
          id: "plugins.pluginAgentSupport.needsSignIn",
          defaultMessage: "{server} (needs sign-in)",
        },
        { server: limitation.serverKey },
      );
    case "connected-app":
      return limitation.name;
    case "hooks":
      return getIntl().formatMessage({
        id: "plugins.pluginAgentSupport.hooksItem",
        defaultMessage: "hooks",
      });
  }
}

const KIND_PHRASES = {
  "mcp-server-needs-sign-in": defineMessage({
    id: "plugins.pluginAgentSupport.serversNeedSignIn",
    defaultMessage: "servers that need a sign-in",
  }),
  "connected-app": defineMessage({
    id: "plugins.pluginAgentSupport.connectedApps",
    defaultMessage: "connected apps",
  }),
  hooks: defineMessage({ id: "plugins.pluginAgentSupport.hooksKind", defaultMessage: "hooks" }),
} as const satisfies Record<PluginOutsideCodexLimitation["kind"], MessageDescriptor>;

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
  intl: IntlShape = getIntl(),
): {
  readonly agents: string;
  readonly codexOnly: string | null;
} {
  const supportedAgents = intl.formatMessage(OTHER_AGENTS);
  if (support.outsideCodex === "none")
    return {
      agents: intl.formatMessage({
        id: "plugins.pluginAgentSupport.codexOnly",
        defaultMessage: "Codex only",
      }),
      codexOnly: null,
    };
  if (support.limitations.length === 0) return { agents: supportedAgents, codexOnly: null };
  if (detail === "items")
    return {
      agents: supportedAgents,
      codexOnly: intl.formatMessage(
        {
          id: "plugins.pluginAgentSupport.codexOnlyItems",
          defaultMessage: "Only in Codex: {items}",
        },
        {
          items: support.limitations
            .map(describeLimitation)
            .join(intl.locale === "zh-CN" ? "、" : ", "),
        },
      ),
    };
  const kinds = [...new Set(support.limitations.map(({ kind }) => KIND_PHRASES[kind]))];
  const labels = kinds.map((kind) => intl.formatMessage(kind));
  const sentence = intl.locale === "en-US" ? joinPhrases(labels) : intl.formatList(labels);
  return {
    agents: supportedAgents,
    codexOnly: intl.formatMessage(
      {
        id: "plugins.pluginAgentSupport.codexOnlyKinds",
        defaultMessage: "{items} work only in Codex",
      },
      { items: sentence.charAt(0).toUpperCase() + sentence.slice(1) },
    ),
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
  intl: IntlShape = getIntl(),
): string {
  if (scope.kind === "all")
    return intl.formatMessage({
      id: "plugins.pluginAgentSupport.allProjects",
      defaultMessage: "All projects",
    });
  const names = scope.projectIds.flatMap(
    (id) => projects.find((project) => project.id === id)?.name ?? [],
  );
  const count = scope.projectIds.length;
  if (count === 1 && names.length === 1) return names[0]!;
  return intl.formatMessage(
    {
      id: "plugins.pluginAgentSupport.projectCount",
      defaultMessage: "{count, plural, one {# project} other {# projects}}",
    },
    { count },
  );
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
