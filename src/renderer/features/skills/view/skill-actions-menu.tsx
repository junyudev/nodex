import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { MoreActionsButton, type MoreActionsVariant } from "@/components/ui/toolbar-button";
import { writeTextToClipboard } from "@/lib/clipboard";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import type {
  SkillInventoryContext,
  SkillInventoryEntry,
  SkillLocation,
} from "../../../../shared/skill-inventory";
import { useSkillCommands } from "../skill-inventory";
import {
  availableSkillSlug,
  describeSkillReaders,
  displaySkillLocation,
  skillSlugFromInput,
} from "../skill-presentation";

function revealLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (platform.startsWith("Mac")) return "Reveal in Finder";
  if (platform.startsWith("Win")) return "Reveal in File Explorer";
  return "Reveal in File Manager";
}

function directoryName(skill: Pick<SkillInventoryEntry, "directory" | "name">): string {
  const last = skill.directory.split(/[\\/]/u).at(-1) ?? "";
  return skillSlugFromInput(last) ?? skillSlugFromInput(skill.name) ?? "skill";
}

export interface SkillActionsMenuProps {
  readonly context: SkillInventoryContext;
  readonly skill: SkillInventoryEntry;
  readonly location: SkillLocation;
  /** Every folder a skill can be copied or moved into. */
  readonly destinations: readonly SkillLocation[];
  readonly variant?: MoreActionsVariant;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Called with the skill a copy or move produced, so the caller can show it. */
  readonly beforeTransfer?: () => Promise<boolean>;
  readonly onRelocated?: (skillId: string, mode: "copy" | "move") => void;
  readonly onDeleted?: () => void;
  readonly onTry?: () => void;
}

/**
 * What can be done with a skill as a folder: try it, duplicate it, put it where another Agent
 * reads, find it on disk, or delete it. Copying and moving name the folder and its Agents, since
 * the folder a skill lives in is what decides who can use it.
 */
export function SkillActionsMenu({
  context,
  skill,
  location,
  destinations,
  variant = "toolbar",
  open,
  onOpenChange,
  beforeTransfer,
  onRelocated,
  onDeleted,
  onTry,
}: SkillActionsMenuProps) {
  const commands = useSkillCommands(context);
  const router = useFileReferenceRouter();
  const [busy, setBusy] = useState(false);
  const local = context.hostId === "local";
  const others = destinations.filter((candidate) => candidate.id !== location.id);

  const transfer = async (target: SkillLocation, mode: "copy" | "move") => {
    setBusy(true);
    await runWithCleanup(
      async () => {
        if (beforeTransfer && !(await beforeTransfer())) {
          toast.danger("Save this skill's edits before copying or moving it");
          return;
        }
        const base = directoryName(skill);
        const result = await commands.transfer({
          skillId: skill.id,
          locationId: target.id,
          slug: availableSkillSlug(target, base),
          mode,
        });
        if (result.status !== "ok") {
          toast.danger(result.message);
          return;
        }
        const where = displaySkillLocation(target);
        if (result.value.warning) toast.danger(result.value.warning);
        else if (target.id === location.id) toast.success(`Duplicated ${skill.name}`);
        else toast.success(`${mode === "move" ? "Moved" : "Copied"} ${skill.name} to ${where}`);
        onRelocated?.(result.value.skillId, result.value.sourceRetained ? "copy" : mode);
      },
      {
        onError: () => {
          toast.danger(`Couldn't ${mode} ${skill.name}`);
        },
        cleanup: () => setBusy(false),
      },
    );
  };

  const trash = async () => {
    setBusy(true);
    await runWithCleanup(
      async () => {
        const result = await commands.trash({ skillId: skill.id });
        if (result.status !== "ok") {
          toast.danger(result.message);
          return;
        }
        toast.success(`Moved ${skill.name} to the Trash`);
        onDeleted?.();
      },
      {
        onError: () => {
          toast.danger(`Couldn't delete ${skill.name}`);
        },
        cleanup: () => setBusy(false),
      },
    );
  };

  const destinationItems = (mode: "copy" | "move") =>
    others.map((target) => (
      <NodexDropdownItem
        key={target.id}
        disabled={busy}
        subText={describeSkillReaders(target.readers)}
        onSelect={() => void transfer(target, mode)}
      >
        {displaySkillLocation(target)}
      </NodexDropdownItem>
    ));

  return (
    <NodexDropdownMenu
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      triggerButton={<MoreActionsButton variant={variant} aria-label="Skill actions" />}
    >
      {onTry ? <NodexDropdownItem onSelect={onTry}>Try in a new chat</NodexDropdownItem> : null}
      {location.writable ? (
        <NodexDropdownItem disabled={busy} onSelect={() => void transfer(location, "copy")}>
          Duplicate
        </NodexDropdownItem>
      ) : null}
      {others.length > 0 ? (
        <NodexDropdownFlyoutSubmenuItem label="Copy to" disabled={busy}>
          {destinationItems("copy")}
        </NodexDropdownFlyoutSubmenuItem>
      ) : null}
      {others.length > 0 && skill.writable ? (
        <NodexDropdownFlyoutSubmenuItem label="Move to" disabled={busy}>
          {destinationItems("move")}
        </NodexDropdownFlyoutSubmenuItem>
      ) : null}
      <NodexDropdownSeparator />
      <NodexDropdownItem
        disabled={!local}
        onSelect={() =>
          void router.open({ path: skill.manifestPath }, { external: true, opener: "fileManager" })
        }
      >
        {revealLabel()}
      </NodexDropdownItem>
      <NodexDropdownItem
        onSelect={() => {
          void writeTextToClipboard(skill.directory).then((copied) => {
            if (copied) toast.success("Copied path");
          });
        }}
      >
        Copy path
      </NodexDropdownItem>
      {skill.writable ? (
        <>
          <NodexDropdownSeparator />
          <NodexDropdownItem className="text-danger" disabled={busy} onSelect={() => void trash()}>
            Delete
          </NodexDropdownItem>
        </>
      ) : null}
    </NodexDropdownMenu>
  );
}
