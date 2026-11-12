import type { InstalledAgentPlugin } from "../../../../shared/agent-plugins/ipc";

type PluginInstallationPresentation =
  | { readonly source: "codex-home" }
  | {
      readonly source: "nodex-installed";
      readonly installation: InstalledAgentPlugin;
    };

export function describeInstallation(presentation: PluginInstallationPresentation) {
  if (presentation.source === "codex-home")
    return { source: presentation.source, sourceLabel: "Codex home" };
  const { package: pkg } = presentation.installation;
  return {
    source: presentation.source,
    sourceLabel: "Nodex-installed",
    title: pkg.displayName ?? pkg.identity.name,
    description: pkg.identity.description,
  };
}
