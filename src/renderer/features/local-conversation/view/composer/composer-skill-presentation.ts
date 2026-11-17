import type { IntlShape } from "@/lib/i18n";
import type { CodexComposerPlugin, CodexComposerSkill } from "@/lib/types";
import {
  formatComposerSkillDisplayName,
  formatComposerSkillPluginName,
} from "../../../../../shared/composer-skill-display";
import type { ComposerPromptMentionInput } from "./composer-prompt-editor";

type FormatMessage = Pick<IntlShape, "formatMessage">;

/**
 * Where a skill comes from: System, Personal, Admin installed, or for a repository skill the name
 * of the workspace root that contains it, falling back to Team.
 */
export function formatComposerSkillScopeLabel(
  intl: FormatMessage,
  input: {
    readonly scope: string;
    readonly skillPath: string;
    readonly roots: readonly string[];
    readonly adminLabel?: string | null;
  },
): string {
  switch (input.scope) {
    case "system":
      return intl.formatMessage({
        id: "conversation.composerSkillPresentation.system",
        defaultMessage: "System",
      });
    case "repo":
      return (
        resolveSkillRootName(input.skillPath, input.roots) ??
        intl.formatMessage({
          id: "conversation.composerSkillPresentation.team",
          defaultMessage: "Team",
        })
      );
    case "user":
      return intl.formatMessage({
        id: "conversation.composerSkillPresentation.personal",
        defaultMessage: "Personal",
      });
    case "admin":
      return (
        input.adminLabel ??
        intl.formatMessage({
          id: "conversation.composerSkillPresentation.adminInstalled",
          defaultMessage: "Admin installed",
        })
      );
    default:
      return input.scope;
  }
}

/**
 * How a skill reads in a picker. A plugin-supplied skill is named after its plugin, as listed,
 * rather than the plugin's ID: `Spotify: Browse Collections`, `From Spotify`.
 */
export function resolveComposerSkillNames(
  intl: FormatMessage,
  skill: CodexComposerSkill,
  plugins: readonly CodexComposerPlugin[],
): { readonly title: string; readonly pluginLabel: string | null } {
  if (!skill.pluginId) return { title: skill.displayName, pluginLabel: null };
  const plugin = plugins.find((candidate) => candidate.id === skill.pluginId);
  const pluginName = plugin?.displayName || formatComposerSkillPluginName(skill.pluginId);
  const namespaceEnd = skill.name.lastIndexOf(":");
  // Only a title made from the skill's name changes; a title the skill declares stays.
  const titleFromName =
    plugin &&
    namespaceEnd > 0 &&
    skill.name.slice(0, namespaceEnd) === plugin.name &&
    skill.displayName === formatComposerSkillDisplayName(skill.name);
  return {
    title: titleFromName
      ? `${pluginName}: ${formatComposerSkillDisplayName(skill.name.slice(namespaceEnd + 1))}`
      : skill.displayName,
    pluginLabel: intl.formatMessage(
      {
        id: "conversation.composerSkillPresentation.fromPlugin",
        defaultMessage: "From {plugin}",
      },
      { plugin: pluginName },
    ),
  };
}

/** The skill chip a picked skill becomes in the draft. */
export function buildComposerSkillMention(skill: CodexComposerSkill): ComposerPromptMentionInput {
  return {
    kind: "skill",
    name: skill.name,
    displayName: skill.displayName,
    path: skill.path,
    description: skill.description,
    iconUrl: skill.iconUrl,
    brandColor: skill.brandColor,
  };
}

/** Name of the longest root that prefixes the skill's path. */
function resolveSkillRootName(skillPath: string, roots: readonly string[]): string | null {
  let containingRoot: string | null = null;
  for (const root of roots) {
    if (skillPath.startsWith(root) && (!containingRoot || root.length > containingRoot.length)) {
      containingRoot = root;
    }
  }
  if (!containingRoot) return null;
  const trimmedRoot = containingRoot.replace(/[\\/]+$/u, "");
  const separator = Math.max(trimmedRoot.lastIndexOf("/"), trimmedRoot.lastIndexOf("\\"));
  const name = separator === -1 ? trimmedRoot : trimmedRoot.slice(separator + 1);
  return name.length > 0 ? name : null;
}
