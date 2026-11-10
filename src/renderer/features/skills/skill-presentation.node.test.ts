import { expect, test } from "vite-plus/test";
import {
  availableSkillSlug,
  describeSkillAvailability,
  describeSkillReaders,
  displaySkillDirectory,
  findSkill,
  groupSkillLocations,
  skillSlugFromInput,
} from "./skill-presentation";
import { personalSkills, projectSkills, skill, skillInventory } from "./skill-test-fixtures";

test("groups matches by folder and keeps empty writable locations when browsing", () => {
  expect(groupSkillLocations(skillInventory, "")).toEqual({
    groups: [{ location: projectSkills, skills: [skill] }],
    empty: [personalSkills],
  });
  expect(groupSkillLocations(skillInventory, " REVIEW ").groups[0]?.skills).toEqual([skill]);
  expect(groupSkillLocations(skillInventory, "missing")).toEqual({ groups: [], empty: [] });
  expect(findSkill(skillInventory, skill.id)).toEqual({ location: projectSkills, skill });
  expect(findSkill(skillInventory, "missing")).toBeNull();
});

test("describes readers and shadowed availability distinctly", () => {
  expect(describeSkillReaders([...personalSkills.readers, ...projectSkills.readers])).toBe(
    "Codex and Claude read this folder",
  );
  expect(describeSkillAvailability({ ...skill.agents[0]!, discovery: "shadowed" })).toBe(
    "Codex uses another skill with this name instead",
  );
  expect(displaySkillDirectory(personalSkills.directory)).toBe("~/.claude/skills");
});

test("uses directory names when choosing the next free slug", () => {
  expect(skillSlugFromInput("  Inspect Release!  ")).toBe("inspect-release");
  expect(skillSlugFromInput("!!!")).toBeNull();
  expect(availableSkillSlug(projectSkills, "inspect")).toBe("inspect-2");
});
