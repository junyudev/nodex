import { SkillsGlyphIcon } from "@/components/shared/icons/customize-icons";
import type { IntlShape } from "@/lib/i18n";
import type { CodexComposerSkill } from "@/lib/types";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  buildComposerSkillMention,
  formatComposerSkillPluginLabel,
  formatComposerSkillScopeLabel,
} from "../composer-skill-presentation";
import type { ComposerSlashCommand, ComposerSlashCommandSelection } from "./slash-command-types";

const COMPOSER_SKILL_SLASH_COMMAND_PREFIX = "skill:";

export interface ComposerSkillSlashCommandsInput {
  readonly inventory: readonly CodexComposerSkill[];
  /** Roots that name repository skills. */
  readonly roots: readonly string[];
}

/**
 * Every skill the person may start, under one Skills heading. Picking one puts its chip where the
 * slash query was, so the skill runs with the rest of the message.
 */
export function buildComposerSkillSlashCommands(
  input: ComposerSkillSlashCommandsInput,
  intl: Pick<IntlShape, "formatMessage">,
): ComposerSlashCommand[] {
  const group = intl.formatMessage({
    id: "conversation.slashCommandSkills.group",
    defaultMessage: "Skills",
  });
  const seenPaths = new Set<string>();
  return input.inventory
    .filter((skill) => {
      if (skill.userInvocable === false || seenPaths.has(skill.path)) return false;
      seenPaths.add(skill.path);
      return true;
    })
    .map((skill) => ({ skill, sortKey: skill.name.toLowerCase() }))
    .sort((left, right) =>
      left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0,
    )
    .map(({ skill }) => {
      const insert = (selection: ComposerSlashCommandSelection) =>
        selection.insertMention(buildComposerSkillMention(skill));
      return {
        id: `${COMPOSER_SKILL_SLASH_COMMAND_PREFIX}${skill.path}`,
        title: skill.displayName,
        description: skill.description,
        group,
        icon: <SkillsGlyphIcon size={16} className="icon-xs" />,
        trailing: (
          <ComposerSkillSource
            scopeLabel={formatComposerSkillScopeLabel(intl, {
              scope: skill.scope,
              skillPath: skill.path,
              roots: input.roots,
            })}
            pluginLabel={
              skill.pluginId ? formatComposerSkillPluginLabel(intl, skill.pluginId) : null
            }
          />
        ),
        requiresEmptyComposer: false,
        onSelect: insert,
        onSelectFromInlineSlash: insert,
      } satisfies ComposerSlashCommand;
    });
}

function ComposerSkillSource({
  scopeLabel,
  pluginLabel,
}: {
  readonly scopeLabel: string;
  readonly pluginLabel: string | null;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-token-description-foreground">
      {scopeLabel}
      {pluginLabel ? (
        <>
          <span aria-hidden="true" className="size-0.5 shrink-0 rounded-full bg-current" />
          <NodexTooltip tooltipContent={pluginLabel} delayOpen>
            <span className="max-w-28 truncate sm:max-w-40">{pluginLabel}</span>
          </NodexTooltip>
        </>
      ) : null}
    </span>
  );
}
