import { formatCodexMcpVisualSourceName } from "./codex-mcp-tool-call";

/**
 * Title for a skill that declares no display name: each `:`-separated namespace becomes title
 * words, so `internal-tools:github-pr` reads `Internal Tools: GitHub PR`.
 */
export function formatComposerSkillDisplayName(name: string): string {
  return name
    .split(":")
    .map((part) => formatCodexMcpVisualSourceName(part))
    .join(": ");
}

/** Plugin name shown beside its skills, without the `@marketplace` suffix of its ID. */
export function formatComposerSkillPluginName(pluginId: string): string {
  const marketplaceSeparator = pluginId.lastIndexOf("@");
  const hasMarketplace = marketplaceSeparator > 0 && marketplaceSeparator < pluginId.length - 1;
  return formatComposerSkillDisplayName(
    hasMarketplace ? pluginId.slice(0, marketplaceSeparator) : pluginId,
  );
}
