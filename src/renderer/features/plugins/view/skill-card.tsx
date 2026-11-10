import { createElement, useState } from "react";
import { CheckIcon17, PlusMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { skillFallbackIcon } from "@/components/shared/icons/skill-fallback-icons";
import { CardTile } from "@/components/ui/card-tile";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RecommendedSkill } from "../../../../shared/codex-plugin-settings";
import { skillDisplayName } from "../model/plugin-detail-model";
import { type PluginContext } from "../plugin-management";
import { DetailDialog, DetailDialogTitle } from "./detail-dialog";
import { SkillInstructions } from "./skill-preview-modal";

/** A skill's icon: its own artwork when it has one, else a glyph chosen from its name. */
export function SkillIcon({
  skill,
  className,
}: {
  readonly skill: {
    readonly name: string;
    readonly description?: string | null;
    readonly iconUrl?: string | null;
    readonly interface?: { readonly iconSmallUrl?: string | null } | null;
  };
  readonly className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = skill.iconUrl ?? skill.interface?.iconSmallUrl ?? null;
  if (url != null && failedUrl !== url) {
    return (
      <span className={cn("block overflow-hidden rounded-2xs", className)}>
        <img
          src={url}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailedUrl(url)}
        />
      </span>
    );
  }
  return createElement(skillFallbackIcon(skill), {
    className: cn("text-(--color-text-secondary)", className),
  });
}

/** The 28px status at the end of a skill row: a check, or an empty slot. */
function SkillStatus({ label }: { readonly label: string | null }) {
  return label == null ? (
    <span aria-hidden className="size-7 shrink-0" />
  ) : (
    <span
      role="img"
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md text-token-description-foreground"
    >
      <CheckIcon17 className="icon-sm opacity-60" />
    </span>
  );
}

/**
 * A recommended skill that isn't installed: Install skill adds it to your personal skills. Once
 * installed, the row keeps a check until the installed list catches up.
 */
export function RecommendedSkillCard({
  skill,
  context,
  isInstalled,
  isInstalling,
  isHighlighted = false,
  canInstall,
  onInstall,
}: {
  readonly skill: RecommendedSkill;
  readonly context: PluginContext;
  readonly isInstalled: boolean;
  readonly isInstalling: boolean;
  readonly isHighlighted?: boolean;
  readonly canInstall: boolean;
  readonly onInstall: (skill: RecommendedSkill) => void;
}) {
  const [open, setOpen] = useState(false);
  const title = skillDisplayName({ name: skill.name });
  const description =
    skill.shortDescription && skill.shortDescription.length > 0
      ? skill.shortDescription
      : skill.description;
  const disabled = isInstalled || !canInstall || isInstalling;
  return (
    <>
      <CardTile
        presentation="card"
        className="justify-center"
        icon={<SkillIcon skill={skill} className="icon-md" />}
        title={title}
        description={description}
        descriptionClassName="line-clamp-1"
        isHighlighted={isInstalled || isHighlighted}
        actions={
          isInstalled ? (
            <SkillStatus label="Installed" />
          ) : (
            <NodexTooltip tooltipContent="Install skill" side="top">
              <ToolbarButton
                aria-label="Install skill"
                color="secondary"
                disabled={disabled}
                loading={isInstalling}
                className="rounded-full px-3"
                onClick={(event) => {
                  event.stopPropagation();
                  if (!disabled) onInstall(skill);
                }}
              >
                Install skill
              </ToolbarButton>
            </NodexTooltip>
          )
        }
        onClick={() => setOpen(true)}
      />
      <DetailDialog
        iconShape="rounded"
        open={open}
        onOpenChange={setOpen}
        icon={<SkillIcon skill={skill} className="icon-md" />}
        title={<DetailDialogTitle title={title} kind="Skill" />}
        titleText={title}
        description={description}
        footer={
          <div className="flex w-full justify-end">
            <ToolbarButton
              color="primary"
              className="rounded-full"
              disabled={disabled}
              loading={isInstalling}
              onClick={() => onInstall(skill)}
            >
              {disabled ? null : <PlusMdIcon />}
              {isInstalled ? "Installed" : "Install skill"}
            </ToolbarButton>
          </div>
        }
      >
        <SkillInstructions context={context} selector={{ recommendedSkillId: skill.id }} />
      </DetailDialog>
    </>
  );
}
