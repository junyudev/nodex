import { createElement, useState, type ReactNode } from "react";
import { TrashIcon } from "@/components/shared/icons/customize-action-icons";
import {
  ChatBubblesIcon16,
  CheckIcon17,
  PlusMdIcon,
  XmarkMdIcon,
} from "@/components/shared/icons/plugin-detail-icons";
import { skillFallbackIcon } from "@/components/shared/icons/skill-fallback-icons";
import { Badge } from "@/components/ui/badge";
import { NodexSwitch } from "@/components/ui/button";
import { CardTile } from "@/components/ui/card-tile";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { MoreActionsButton, ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { RecommendedSkill } from "../../../../shared/codex-plugin-settings";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { skillDisplayName, skillShortDescription } from "../model/plugin-detail-model";
import { skillTryPrompt } from "../model/skill-model";
import { usePluginManagement, type PluginContext } from "../plugin-management";
import { DetailDialog, DetailDialogTitle } from "./detail-dialog";
import { SkillFileMenu, SkillInstructions } from "./skill-preview-modal";

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

/** Personal and project skills can be removed; built-in and administrator skills cannot. */
function canRemoveSkill(context: PluginContext, skill: SkillMetadata): boolean {
  return context.hostId === "local" && (skill.scope === "user" || skill.scope === "repo");
}

/**
 * An installed skill. In `check` mode its row shows a check while enabled; in `menu` mode a
 * hover menu disables or uninstalls it and a disabled skill offers Enable. Clicking the row
 * previews the skill, where it can be switched off, opened, uninstalled, or tried.
 */
export function SkillCard({
  skill,
  context,
  onStartChat,
  isHighlighted = false,
  mode = "check",
}: {
  readonly skill: SkillMetadata;
  readonly context: PluginContext;
  readonly onStartChat: (prompt: string) => void;
  readonly isHighlighted?: boolean;
  readonly mode?: "check" | "menu";
}) {
  const management = usePluginManagement(context);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [updating, setUpdating] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const name = skillDisplayName(skill);
  const description = skillShortDescription({
    description: skill.description,
    shortDescription: skill.shortDescription ?? null,
    interface: skill.interface,
  });
  const enabled = optimistic ?? skill.enabled;
  const toggleLabel = enabled ? "Disable skill" : "Enable skill";
  const removable = canRemoveSkill(context, skill);

  const setEnabled = async (next: boolean) => {
    setOptimistic(next);
    setUpdating(true);
    try {
      const result = await management.setSkillEnabled(
        skill.name.includes(":")
          ? { name: skill.name, enabled: next }
          : { path: skill.path, enabled: next },
      );
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      toast.success(next ? `${name} skill enabled` : `${name} skill disabled`);
    } catch {
      setOptimistic(null);
      toast.danger("Failed to update skill");
    } finally {
      setUpdating(false);
    }
  };
  const uninstall = async () => {
    setUninstalling(true);
    try {
      const result = await management.uninstallSkill({ path: skill.path });
      if (!pluginMutationSucceeded(result)) throw new Error(result.error.message);
      toast.success(`${name} skill uninstalled`);
    } catch {
      toast.danger("Failed to uninstall skill");
    } finally {
      setUninstalling(false);
    }
  };

  let actions: ReactNode;
  if (mode === "menu") {
    actions = (
      <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        <div
          className={
            menuOpen
              ? "visible opacity-100"
              : "invisible opacity-0 group-hover:visible group-hover:opacity-100"
          }
        >
          <NodexDropdownMenu
            align="end"
            contentWidth="icon"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            triggerButton={
              <MoreActionsButton
                variant="toolbar"
                aria-label="Skill actions"
                className={menuOpen ? "opacity-100" : "opacity-50 hover:opacity-100"}
              />
            }
          >
            {enabled ? (
              <NodexDropdownItem leftSlot={<XmarkMdIcon />} onSelect={() => void setEnabled(false)}>
                Disable
              </NodexDropdownItem>
            ) : null}
            {removable ? (
              <NodexDropdownItem
                leftSlot={<TrashIcon />}
                className="text-danger"
                disabled={uninstalling}
                onSelect={() => void uninstall()}
              >
                Uninstall
              </NodexDropdownItem>
            ) : null}
          </NodexDropdownMenu>
        </div>
        {enabled ? (
          <SkillStatus label="Skill enabled" />
        ) : (
          <ToolbarButton
            color="outline"
            disabled={updating || uninstalling}
            onClick={() => void setEnabled(true)}
          >
            Enable
          </ToolbarButton>
        )}
      </div>
    );
  } else {
    actions = <SkillStatus label={enabled ? "Skill enabled" : null} />;
  }

  return (
    <>
      <CardTile
        presentation="card"
        className={cn("justify-center", mode === "menu" && "group")}
        contentClassName={enabled ? undefined : "opacity-60"}
        icon={<SkillIcon skill={skill} className="icon-md" />}
        title={name}
        description={description}
        descriptionClassName="line-clamp-1"
        isHighlighted={isHighlighted}
        actions={actions}
        onClick={() => setOpen(true)}
      />
      <DetailDialog
        iconShape="rounded"
        open={open}
        onOpenChange={setOpen}
        icon={<SkillIcon skill={skill} className="icon-md" />}
        title={
          <DetailDialogTitle
            kind="Skill"
            title={name}
            badge={enabled ? null : <Badge variant="outline">Disabled</Badge>}
          />
        }
        titleText={name}
        description={description}
        headerActions={
          <div className="flex items-center gap-2">
            <NodexTooltip tooltipContent={toggleLabel} side="bottom">
              <span className="flex h-token-button-composer items-center">
                <NodexSwitch
                  ariaLabel={toggleLabel}
                  checked={enabled}
                  disabled={updating}
                  onCheckedChange={(next) => void setEnabled(next)}
                />
              </span>
            </NodexTooltip>
            <SkillFileMenu context={context} path={skill.path} onOpened={() => setOpen(false)} />
          </div>
        }
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {removable ? (
                <ToolbarButton
                  color="outline"
                  className="rounded-full border-(--color-text-danger) bg-transparent text-(--color-text-danger)"
                  disabled={uninstalling}
                  onClick={() => {
                    setOpen(false);
                    void uninstall();
                  }}
                >
                  Uninstall
                </ToolbarButton>
              ) : null}
            </div>
            <ToolbarButton
              color="primary"
              className="rounded-full"
              disabled={!enabled || updating}
              onClick={() => onStartChat(skillTryPrompt(skill))}
            >
              <ChatBubblesIcon16 />
              Try now
            </ToolbarButton>
          </div>
        }
      >
        <SkillInstructions context={context} selector={{ path: skill.path }} />
      </DetailDialog>
    </>
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
