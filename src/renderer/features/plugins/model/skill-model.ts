import { defineMessages, type MessageDescriptor, getIntl } from "@/lib/i18n";
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

const SCOPE_LABELS = defineMessages({
  user: { id: "plugins.skillModel.personal", defaultMessage: "Personal" },
  system: { id: "plugins.skillModel.system", defaultMessage: "System" },
  repo: { id: "plugins.skillModel.team", defaultMessage: "Team" },
  admin: { id: "plugins.skillModel.admin", defaultMessage: "Admin installed" },
} satisfies Record<SkillMetadata["scope"], MessageDescriptor>);

/**
 * Where a skill is installed, as its directory tab label. A repository skill is labeled with
 * the folder of the workspace that contains it.
 */
function skillScopeRoot(skillPath: string, roots: readonly string[]): string | undefined {
  let match: string | null = null;
  for (const root of roots) {
    const normalized = root.replace(/\/+$/, "");
    if (skillPath !== normalized && !skillPath.startsWith(`${normalized}/`)) continue;
    if (match == null || normalized.length > match.length) match = normalized;
  }
  return match?.split("/").at(-1);
}

export function skillScopeLabel(
  skill: Pick<SkillMetadata, "scope" | "path">,
  roots: readonly string[] = [],
  intl = getIntl(),
): string {
  const folder = skill.scope === "repo" ? skillScopeRoot(skill.path, roots) : undefined;
  return folder || intl.formatMessage(SCOPE_LABELS[skill.scope]);
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
    const folder = skill.scope === "repo" ? skillScopeRoot(skill.path, roots) : undefined;
    const label = folder || SCOPE_LABELS[skill.scope].defaultMessage;
    groups.set(label, [...(groups.get(label) ?? []), skill]);
  }
  return [...groups].map(([groupKey, members]) => ({
    id: `skills-installed-${groupKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`,
    title: skillScopeLabel(members[0]!, roots),
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
