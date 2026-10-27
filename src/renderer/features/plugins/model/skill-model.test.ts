import { describe, expect, it } from "vitest";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import {
  filterSkills,
  groupSkillsByScope,
  markdownLink,
  skillScopeLabel,
  skillTryPrompt,
  skillsVisibleLimit,
} from "./skill-model";

const skill = (patch: Partial<SkillMetadata>): SkillMetadata => ({
  name: "fix-ci",
  description: "Repair failing checks",
  path: "/Users/me/.codex/skills/fix-ci/SKILL.md",
  scope: "user",
  enabled: true,
  pluginId: null,
  ...patch,
});

describe("skill drafts", () => {
  it("mentions the skill after its starter prompt unless the prompt already does", () => {
    expect(skillTryPrompt({ name: "fix-ci", path: "/s/fix-ci/SKILL.md" })).toBe(
      "[$fix-ci](/s/fix-ci/SKILL.md) ",
    );
    expect(
      skillTryPrompt({
        name: "fix-ci",
        path: "/s/fix-ci/SKILL.md",
        interface: { defaultPrompt: "Fix the build" },
      }),
    ).toBe("Fix the build [$fix-ci](/s/fix-ci/SKILL.md) ");
    expect(
      skillTryPrompt({
        name: "Fix-CI",
        path: "/s/SKILL.md",
        interface: { defaultPrompt: "Use [$fix-ci](/s/SKILL.md) now" },
      }),
    ).toBe("Use [$fix-ci](/s/SKILL.md) now ");
    expect(skillTryPrompt({ name: "lint", path: null })).toBe("$lint ");
  });

  it("escapes link labels and destinations", () => {
    expect(markdownLink("[a](b)", "/x (y)/SKILL.md")).toBe("[\\[a\\]\\(b)](/x (y\\)/SKILL.md)");
  });
});

describe("skill directory", () => {
  it("labels scopes and names repository skills after their workspace folder", () => {
    expect(skillScopeLabel({ scope: "user", path: "/a" })).toBe("Personal");
    expect(skillScopeLabel({ scope: "admin", path: "/a" })).toBe("Admin installed");
    expect(
      skillScopeLabel({ scope: "repo", path: "/work/nodex/.agents/skills/x/SKILL.md" }, [
        "/work",
        "/work/nodex/",
      ]),
    ).toBe("nodex");
    expect(skillScopeLabel({ scope: "repo", path: "/elsewhere/SKILL.md" }, ["/work"])).toBe("Team");
  });

  it("groups skills in order of first appearance", () => {
    const groups = groupSkillsByScope([
      skill({ name: "a", scope: "user" }),
      skill({ name: "b", scope: "system" }),
      skill({ name: "c", scope: "user" }),
    ]);
    expect(groups.map((group) => [group.id, group.skills.map((s) => s.name)])).toEqual([
      ["skills-installed-personal", ["a", "c"]],
      ["skills-installed-system", ["b"]],
    ]);
  });

  it("searches names, display names, and descriptions", () => {
    const skills = [skill({ name: "gh-fix-ci" }), skill({ name: "pdf", description: "Read PDFs" })];
    expect(filterSkills(skills, "fix ci").map((s) => s.name)).toEqual(["gh-fix-ci"]);
    expect(filterSkills(skills, "pdfs").map((s) => s.name)).toEqual(["pdf"]);
    expect(filterSkills(skills, "  ")).toHaveLength(2);
  });

  it("folds a list only when at least three skills would be hidden", () => {
    expect(skillsVisibleLimit(8)).toBeNull();
    expect(skillsVisibleLimit(9)).toBe(6);
  });
});
