import type {
  SkillDocument,
  SkillInventoryEntry,
  SkillInventorySnapshot,
  SkillLocation,
} from "../../../shared/skill-inventory";

export const skillContext = { hostId: "local", projectId: "project-a" };
export const skill: SkillInventoryEntry = {
  id: "inspect",
  name: "inspect",
  description: "Review a release.",
  directory: "/workspace/.agents/skills/inspect",
  manifestPath: "/workspace/.agents/skills/inspect/SKILL.md",
  writable: true,
  parseError: null,
  agents: [
    {
      agent: "codex",
      instanceId: "codex-default",
      invocationName: "inspect",
      state: "enabled",
      discovery: "available",
      toggle: { status: "available", scope: "project" },
    },
  ],
};
export const projectSkills: SkillLocation = {
  id: "project-skills",
  directory: "/workspace/.agents/skills",
  scope: "project",
  writable: true,
  exists: true,
  readers: [{ agent: "codex", instanceId: "codex-default" }],
  skills: [skill],
};
export const personalSkills: SkillLocation = {
  id: "personal-skills",
  directory: "/Users/developer/.claude/skills",
  scope: "user",
  writable: true,
  exists: false,
  readers: [{ agent: "claude", instanceId: "claude-default" }],
  skills: [],
};
export const skillInventory: SkillInventorySnapshot = {
  generation: "1",
  locations: [personalSkills, projectSkills],
  sources: [],
};
export const skillDocument: SkillDocument = {
  skillId: skill.id,
  revision: "1",
  markdown:
    "---\nname: inspect\ndescription: Review a release.\nmetadata: {owner: team}\n---\n\nCheck the release tag.\n",
  files: ["SKILL.md"],
  writable: true,
};
