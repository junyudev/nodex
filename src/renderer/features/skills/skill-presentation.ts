import type {
  SkillAgentAvailability,
  SkillInventoryEntry,
  SkillInventorySnapshot,
  SkillLocation,
  SkillReader,
} from "../../../shared/skill-inventory";

export const AGENT_LABEL = { codex: "Codex", claude: "Claude" } as const;

/** A directory as a person would write it: the home folder becomes `~`. */
export function displaySkillDirectory(directory: string): string {
  return directory
    .replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/u, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/u, "~");
}

/**
 * A folder as its header names it. A Project's folders read from the Project's own directory
 * (`nodex/.agents/skills`), since the path above it says nothing about who can use the skills.
 */
export function displaySkillLocation(location: Pick<SkillLocation, "directory" | "scope">): string {
  if (location.scope !== "project") return displaySkillDirectory(location.directory);
  const separator = location.directory.includes("\\") ? "\\" : "/";
  const segments = location.directory.split(separator).filter(Boolean);
  return segments.length > 3
    ? segments.slice(-3).join(separator)
    : displaySkillDirectory(location.directory);
}

/** What a location is, in the user's words; the directory itself is shown beside it. */
export function skillLocationKind(location: Pick<SkillLocation, "scope">): string {
  if (location.scope === "user") return "Personal";
  if (location.scope === "project") return "Project";
  if (location.scope === "plugin") return "Plugin";
  return "Built in";
}

/** Codex first, then Claude, so marks keep one order everywhere. */
export function orderSkillReaders<Reader extends SkillReader>(
  readers: readonly Reader[],
): readonly Reader[] {
  return readers.toSorted(
    (a, b) =>
      Number(a.agent !== "codex") - Number(b.agent !== "codex") ||
      a.instanceId.localeCompare(b.instanceId),
  );
}

export function describeSkillReaders(readers: readonly SkillReader[]): string {
  const agents = [
    ...new Set(orderSkillReaders(readers).map((reader) => AGENT_LABEL[reader.agent])),
  ];
  if (agents.length === 0) return "No Agent reads this folder";
  return `${agents.join(" and ")} ${agents.length === 1 ? "reads" : "read"} this folder`;
}

/** One sentence on what an Agent makes of a skill, for the mark's tooltip. */
export function describeSkillAvailability(agent: SkillAgentAvailability): string {
  const name = AGENT_LABEL[agent.agent];
  if (agent.discovery === "shadowed") {
    return `${name} uses another skill with this name instead`;
  }
  if (agent.state === "disabled") return `Off for ${name}`;
  if (agent.state === "unknown") return `${name} reads this folder`;
  return `On for ${name}`;
}

export interface SkillListGroup {
  readonly location: SkillLocation;
  readonly skills: readonly SkillInventoryEntry[];
}

const SCOPE_ORDER = { project: 0, user: 1, plugin: 2, system: 3 } as const;

/**
 * Locations in reading order: the project's folders, personal ones, then what plugins and the
 * Agents ship. A search keeps only matching skills and drops the folders it empties.
 */
export function groupSkillLocations(
  snapshot: Pick<SkillInventorySnapshot, "locations">,
  search: string,
): { readonly groups: readonly SkillListGroup[]; readonly empty: readonly SkillLocation[] } {
  const query = search.trim().toLowerCase();
  const ordered = snapshot.locations.toSorted(
    (a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.directory.localeCompare(b.directory),
  );
  const groups: SkillListGroup[] = [];
  const empty: SkillLocation[] = [];
  for (const location of ordered) {
    const skills = location.skills
      .filter(
        (skill) =>
          query.length === 0 ||
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query),
      )
      .toSorted((a, b) => a.name.localeCompare(b.name));
    if (skills.length > 0) groups.push({ location, skills });
    else if (query.length === 0 && location.writable) empty.push(location);
  }
  return { groups, empty };
}

export function findSkill(
  snapshot: Pick<SkillInventorySnapshot, "locations"> | undefined,
  skillId: string,
): { readonly location: SkillLocation; readonly skill: SkillInventoryEntry } | null {
  for (const location of snapshot?.locations ?? []) {
    const skill = location.skills.find((candidate) => candidate.id === skillId);
    if (skill) return { location, skill };
  }
  return null;
}

/** A free directory name in a location: `base`, then `base-2`, `base-3`… */
export function availableSkillSlug(location: Pick<SkillLocation, "skills">, base: string): string {
  const taken = new Set(
    location.skills.map((skill) => skill.directory.split(/[\\/]/u).at(-1)?.toLowerCase()),
  );
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Turns what a person typed as a name into a directory name, or null when nothing usable remains. */
export function skillSlugFromInput(input: string): string | null {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return slug.length > 0 ? slug : null;
}
