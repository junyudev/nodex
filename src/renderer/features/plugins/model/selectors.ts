export * from "../../../../shared/codex-plugin-management-model";

import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { SkillsView, RecommendedSkillsView } from "../../../../shared/codex-plugin-management";
import {
  skillMatchKeys,
  recommendedSkillMatchKeys,
  humanizeSkillName,
} from "../../../../shared/codex-plugin-management-model";
const preferred = ["imagegen", "sora", "pdf", "doc", "spreadsheet", "playwright"];
const skillMatches = (skill: SkillMetadata, query: string) =>
  [
    skill.name,
    skill.interface?.displayName,
    skill.description,
    skill.interface?.shortDescription,
    skill.shortDescription,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
export function selectSkillsBrowse(input: {
  readonly skills: SkillsView | undefined;
  readonly recommended: RecommendedSkillsView | undefined;
  readonly search?: string;
  readonly installedRecommendedIds?: readonly string[];
}) {
  const query = input.search?.trim().toLowerCase() ?? "";
  const installed = input.skills?.installed ?? [];
  const installedKeys = new Set(input.skills?.matchKeys ?? []);
  const installedIds = new Set(input.installedRecommendedIds ?? []);
  const recommended = (input.recommended?.skills ?? [])
    .filter(
      (skill) =>
        installedIds.has(skill.id) ||
        !recommendedSkillMatchKeys(skill).some((key) => installedKeys.has(key)),
    )
    .filter(
      (skill) =>
        !query ||
        [skill.name, skill.description, skill.shortDescription ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(query),
    );
  const visibleRecommended = query
    ? recommended
    : recommended
        .filter((skill) => preferred.includes(humanizeSkillName(skill.name).trim().toLowerCase()))
        .toSorted(
          (a, b) =>
            preferred.indexOf(humanizeSkillName(a.name).toLowerCase()) -
            preferred.indexOf(humanizeSkillName(b.name).toLowerCase()),
        );
  const recommendedKeys = new Set(visibleRecommended.flatMap(recommendedSkillMatchKeys));
  const visibleInstalled = installed.filter(
    (skill) =>
      !skillMatchKeys(skill).some((key) => recommendedKeys.has(key)) && skillMatches(skill, query),
  );
  const allRecommendedKeys = new Set(
    (input.recommended?.skills ?? []).flatMap(recommendedSkillMatchKeys),
  );
  return {
    recommended: visibleRecommended.map((skill) => ({
      ...skill,
      installedSkill:
        installed.find((installed) =>
          skillMatchKeys(installed).some((key) => recommendedSkillMatchKeys(skill).includes(key)),
        ) ?? null,
    })),
    installed: visibleInstalled,
    personal: visibleInstalled.filter((skill) => skill.scope === "user"),
    project: visibleInstalled.filter((skill) => skill.scope === "repo"),
    system: visibleInstalled.filter((skill) => skill.scope === "system"),
    admin: visibleInstalled.filter((skill) => skill.scope === "admin"),
    settingsSkills:
      input.recommended === undefined
        ? []
        : (input.skills?.personal ?? []).filter(
            (skill) =>
              !skillMatchKeys(skill).some((key) => allRecommendedKeys.has(key)) &&
              skillMatches(skill, query),
          ),
  };
}
