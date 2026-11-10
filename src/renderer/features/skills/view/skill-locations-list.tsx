import { useState } from "react";
import { PlusMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  SkillInventoryContext,
  SkillInventoryEntry,
  SkillInventorySnapshot,
  SkillLocation,
} from "../../../../shared/skill-inventory";
import { useSkillCommands } from "../skill-inventory";
import {
  availableSkillSlug,
  describeSkillReaders,
  displaySkillDirectory,
  displaySkillLocation,
  groupSkillLocations,
  skillLocationKind,
} from "../skill-presentation";
import { SkillActionsMenu } from "./skill-actions-menu";
import { SkillAgentMarks, SkillReaderMarks } from "./skill-agent-marks";

export interface SkillLocationsListProps {
  readonly context: SkillInventoryContext;
  readonly snapshot: SkillInventorySnapshot;
  readonly search: string;
  /** The row the search field's arrow keys rest on. */
  readonly highlightedSkillId?: string | null;
  readonly onOpenSkill: (skillId: string, options?: { readonly created?: boolean }) => void;
  readonly onTry?: (skill: SkillInventoryEntry) => void;
}

/** Creates an empty skill in a folder and hands back its id, or reports why it could not. */
export function useCreateSkill(context: SkillInventoryContext) {
  const commands = useSkillCommands(context);
  return async (location: SkillLocation): Promise<string | null> => {
    try {
      const result = await commands.createBlank({
        locationId: location.id,
        slug: availableSkillSlug(location, "new-skill"),
      });
      if (result.status === "ok") return result.value.skillId;
      toast.danger(result.message);
    } catch {
      toast.danger("Couldn't create the skill");
    }
    return null;
  };
}

function LocationHeader({
  location,
  count,
  onCreate,
}: {
  readonly location: SkillLocation;
  readonly count: number | null;
  readonly onCreate?: () => void;
}) {
  return (
    <div className="flex h-8 items-center gap-2 px-(--padding-row-x)">
      <span className="text-sm font-medium text-token-foreground">
        {skillLocationKind(location)}
      </span>
      <NodexTooltip tooltipContent={location.directory} side="top">
        <span className="min-w-0 truncate font-mono text-xs text-token-description-foreground">
          {displaySkillLocation(location)}
        </span>
      </NodexTooltip>
      <SkillReaderMarks readers={location.readers} />
      {count === null ? null : (
        <span className="text-xs text-token-description-foreground tabular-nums">{count}</span>
      )}
      <span className="flex-1" />
      {onCreate ? (
        <NodexTooltip
          tooltipContent={`New skill here · ${describeSkillReaders(location.readers)}`}
          side="top"
        >
          <button
            type="button"
            aria-label={`New skill in ${displaySkillDirectory(location.directory)}`}
            className="flex size-6 cursor-interaction items-center justify-center rounded-md text-token-description-foreground outline-hidden hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:bg-token-foreground/10"
            onClick={onCreate}
          >
            <PlusMdIcon className="icon-xs" />
          </button>
        </NodexTooltip>
      ) : null}
    </div>
  );
}

function SkillRow({
  context,
  skill,
  location,
  destinations,
  highlighted,
  onOpenSkill,
  onTry,
}: {
  readonly context: SkillInventoryContext;
  readonly skill: SkillInventoryEntry;
  readonly location: SkillLocation;
  readonly destinations: readonly SkillLocation[];
  readonly highlighted: boolean;
  readonly onOpenSkill: SkillLocationsListProps["onOpenSkill"];
  readonly onTry?: (skill: SkillInventoryEntry) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const off = skill.agents.length > 0 && skill.agents.every((agent) => agent.state === "disabled");
  return (
    <div
      data-skill-row={skill.id}
      data-search-result-active={highlighted ? "true" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-(--radius-token-row) px-(--padding-row-x) hover:bg-token-foreground/5",
        (highlighted || menuOpen) && "bg-token-foreground/5",
      )}
    >
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 cursor-interaction items-baseline gap-3 text-start outline-hidden before:absolute before:inset-0 before:rounded-(--radius-token-row) focus-visible:before:ring-1 focus-visible:before:ring-token-focus-border focus-visible:before:ring-inset"
        onClick={() => onOpenSkill(skill.id)}
      >
        <span
          className={cn(
            "shrink-0 text-sm leading-9 text-token-foreground",
            off && "text-token-description-foreground",
          )}
        >
          {skill.name}
        </span>
        <span className="min-w-0 truncate text-sm leading-9 text-token-description-foreground">
          {skill.parseError ?? skill.description}
        </span>
      </button>
      <span
        className={cn(
          "relative flex shrink-0 items-center",
          !menuOpen && "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
        )}
      >
        <SkillActionsMenu
          context={context}
          skill={skill}
          location={location}
          destinations={destinations}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onTry={onTry ? () => onTry(skill) : undefined}
        />
      </span>
      <SkillAgentMarks context={context} skill={skill} className="relative shrink-0" />
    </div>
  );
}

/**
 * Every skill, under the folder it lives in. The folder is the point: its header names the
 * Agents that read it, so where a skill sits says who can use it, and each row's marks switch
 * the skill on or off for one Agent at a time. Folders an Agent reads but that hold nothing yet
 * close the list, ready to take a new skill.
 */
export function SkillLocationsList({
  context,
  snapshot,
  search,
  highlightedSkillId = null,
  onOpenSkill,
  onTry,
}: SkillLocationsListProps) {
  const createSkill = useCreateSkill(context);
  const { groups, empty } = groupSkillLocations(snapshot, search);
  const destinations = snapshot.locations.filter((location) => location.writable);
  const create = async (location: SkillLocation) => {
    const skillId = await createSkill(location);
    if (skillId) onOpenSkill(skillId, { created: true });
  };
  return (
    <div className="flex flex-col gap-5">
      {groups.map(({ location, skills }) => (
        <section key={location.id} aria-label={displaySkillDirectory(location.directory)}>
          <LocationHeader
            location={location}
            count={skills.length}
            onCreate={location.writable ? () => void create(location) : undefined}
          />
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              context={context}
              skill={skill}
              location={location}
              destinations={destinations}
              highlighted={highlightedSkillId === skill.id}
              onOpenSkill={onOpenSkill}
              onTry={onTry}
            />
          ))}
        </section>
      ))}
      {empty.length === 0 ? null : (
        <section aria-label="Empty skill folders">
          {empty.map((location) => (
            <LocationHeader
              key={location.id}
              location={location}
              count={null}
              onCreate={() => void create(location)}
            />
          ))}
        </section>
      )}
    </div>
  );
}
