import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import { skillDisplayName } from "./plugin-detail-model";

/** A Markdown link with its label and destination escaped. */
export function markdownLink(label: string, destination: string): string {
  const escapedLabel = label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("](", "]\\(")
    .replaceAll("]", "\\]");
  const escapedDestination = destination.replaceAll("\\", "\\\\").replaceAll(")", "\\)");
  return `[${escapedLabel}](${escapedDestination})`;
}

function withTrailingSpace(text: string): string {
  return text.endsWith(" ") ? text : `${text} `;
}

/**
 * A draft that invokes a skill: its starter prompt when that already mentions the skill, the
 * prompt followed by the skill mention otherwise, or the mention alone.
 */
export function skillTryPrompt(skill: {
  readonly name: string;
  readonly path: string | null;
  readonly interface?: { readonly defaultPrompt?: string } | null;
}): string {
  const mention = skill.path ? markdownLink(`$${skill.name}`, skill.path) : `$${skill.name}`;
  const prompt = skill.interface?.defaultPrompt?.trim();
  if (!prompt) return withTrailingSpace(mention);
  const lower = prompt.toLowerCase();
  if (lower.includes(`[$${skill.name.toLowerCase()}](`)) return withTrailingSpace(prompt);
  if (!skill.path && lower.includes(`$${skill.name.toLowerCase()}`)) {
    return withTrailingSpace(prompt);
  }
  return withTrailingSpace(`${prompt} ${mention}`);
}

const SCOPE_LABELS: Record<SkillMetadata["scope"], string> = {
  user: "Personal",
  system: "System",
  repo: "Team",
  admin: "Admin installed",
};

/**
 * Where a skill is installed, as its directory tab label. A repository skill is labeled with
 * the folder of the workspace that contains it.
 */
export function skillScopeLabel(
  skill: Pick<SkillMetadata, "scope" | "path">,
  roots: readonly string[] = [],
): string {
  if (skill.scope !== "repo") return SCOPE_LABELS[skill.scope];
  let match: string | null = null;
  for (const root of roots) {
    const normalized = root.replace(/\/+$/, "");
    if (skill.path !== normalized && !skill.path.startsWith(`${normalized}/`)) continue;
    if (match == null || normalized.length > match.length) match = normalized;
  }
  return match?.split("/").at(-1) || SCOPE_LABELS.repo;
}

export interface SkillScopeGroup {
  readonly id: string;
  readonly title: string;
  readonly skills: readonly SkillMetadata[];
}

/** Skills grouped by where they are installed, in order of first appearance. */
export function groupSkillsByScope(
  skills: readonly SkillMetadata[],
  roots: readonly string[] = [],
): SkillScopeGroup[] {
  const groups = new Map<string, SkillMetadata[]>();
  for (const skill of skills) {
    const label = skillScopeLabel(skill, roots);
    groups.set(label, [...(groups.get(label) ?? []), skill]);
  }
  return [...groups].map(([title, members]) => ({
    id: `skills-installed-${title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`,
    title,
    skills: members,
  }));
}

/** Skills whose name, display name, or description contains the query. */
export function filterSkills(
  skills: readonly SkillMetadata[],
  query: string,
): readonly SkillMetadata[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return skills;
  return skills.filter((skill) =>
    [skill.name, skillDisplayName(skill), skill.description].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

/** How many skills a list shows before "See …": six, but only when at least three would fold. */
export function skillsVisibleLimit(count: number, limit = 6): number | null {
  return count - limit >= 3 ? limit : null;
}
