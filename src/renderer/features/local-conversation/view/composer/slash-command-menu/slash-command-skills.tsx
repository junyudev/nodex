import { SkillsGlyphIcon } from "@/components/shared/icons/customize-icons";
import type { IntlShape } from "@/lib/i18n";
import type { CodexComposerPlugin, CodexComposerSkill } from "@/lib/types";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  buildComposerSkillMention,
  formatComposerSkillScopeLabel,
  resolveComposerSkillNames,
} from "../composer-skill-presentation";
import type { ComposerSlashCommand, ComposerSlashCommandSection } from "./slash-command-types";

const COMPOSER_SKILL_SLASH_COMMAND_PREFIX = "skill:";

export interface ComposerSkillSlashCommandsInput {
  readonly inventory: readonly CodexComposerSkill[];
  /** Roots that name repository skills. */
  readonly roots: readonly string[];
  /** Plugins that name the skills they supply. */
  readonly plugins: readonly CodexComposerPlugin[];
}

/**
 * Every skill the person may start, under one Skills heading. Picking one puts its chip where the
 * slash query was, so the skill runs with the rest of the message.
 */
export function buildComposerSkillSlashCommands(
  input: ComposerSkillSlashCommandsInput,
  intl: Pick<IntlShape, "formatMessage">,
): ComposerSlashCommand[] {
  const section: ComposerSlashCommandSection = {
    kind: "skills",
    label: intl.formatMessage({
      id: "conversation.slashCommandSkills.group",
      defaultMessage: "Skills",
    }),
  };
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
    .map(({ skill }): ComposerSlashCommand => {
      const names = resolveComposerSkillNames(intl, skill, input.plugins);
      return {
        id: `${COMPOSER_SKILL_SLASH_COMMAND_PREFIX}${skill.path}`,
        title: names.title,
        description: skill.description,
        section,
        icon: <SkillsGlyphIcon size={16} className="icon-xs" />,
        trailing: (
          <ComposerSkillSource
            scopeLabel={formatComposerSkillScopeLabel(intl, {
              scope: skill.scope,
              skillPath: skill.path,
              roots: input.roots,
            })}
            pluginLabel={names.pluginLabel}
          />
        ),
        requiresEmptyComposer: false,
        action: {
          kind: "insert",
          insert: (draft) => draft.insertMention(buildComposerSkillMention(skill)),
        },
      };
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
