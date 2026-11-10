import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseScenarioFacts, type ScenarioDomainRecipe } from "../contracts";

export const SKILLS_PAGES_SCENARIO_ID = "skills-pages";
export const SKILLS_PAGES_PROJECT = "Release Engineering";
export const RELEASE_SKILL_PATH = ".agents/skills/release-checklist/SKILL.md";
export const RELEASE_PARAGRAPH = "Review the changes since the last release tag.";
export const RELEASE_SKILL = [
  "---",
  "name: release-checklist",
  "description: Prepare a release and report outstanding checks.",
  "metadata:",
  "  team: release-engineering",
  "---",
  "",
  "## Prepare the release",
  "",
  RELEASE_PARAGRAPH,
  "",
  "Run the [release checks](scripts/check-release.sh) and compare the results",
  "with the [handoff guide](references/handoff.md).",
  "",
].join("\n");

const manifest = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

export const skillsPagesScenario: ScenarioDomainRecipe = {
  id: SKILLS_PAGES_SCENARIO_ID,
  revision: 1,
  async materialize(port, workspace) {
    const projectRoot = path.join(workspace, "release-engineering");
    const fixtures = {
      [RELEASE_SKILL_PATH]: RELEASE_SKILL,
      ".agents/skills/release-checklist/scripts/check-release.sh":
        "#!/bin/sh\nset -eu\ngit diff --check\n",
      ".agents/skills/release-checklist/references/handoff.md":
        "# Release handoff\n\nRecord the tag, checks, and rollback owner.\n",
      ".agents/skills/incident-summary/SKILL.md": manifest(
        "incident-summary",
        "Summarize an incident timeline and handoff.",
        "## Incident timeline\n\nRecord each confirmed event with its UTC timestamp.",
      ),
      ".agents/skills/status-template/SKILL.md": manifest(
        "status-template",
        "Draft the release status using the team's HTML template.",
        '<aside data-status="pending">Release checks are pending.</aside>',
      ),
      ".claude/skills/verify-runbook/SKILL.md": manifest(
        "verify-runbook",
        "Check a runbook for missing recovery steps.",
        "## Review\n\nConfirm every destructive step has a rollback procedure.",
      ),
    };
    for (const [relativePath, text] of Object.entries(fixtures)) {
      const filePath = path.join(projectRoot, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, text, { flag: "wx" });
    }
    const project = await port.createProject({
      name: SKILLS_PAGES_PROJECT,
      sources: [projectRoot],
    });
    if (!project.defaultDatabaseViewId) throw new Error("Skills Project has no default View");
    return {
      version: 1,
      scenarioId: SKILLS_PAGES_SCENARIO_ID,
      scenarioRevision: 1,
      projectId: project.id,
      databaseViewId: project.defaultDatabaseViewId,
      pageIdsByKey: {},
      minimumCommitSeq: 0,
      materializedAt: new Date().toISOString(),
    };
  },
  async inspect(_port, { scenarioId, scenarioRevision }) {
    return { scenarioId, scenarioRevision };
  },
  parseFacts: parseScenarioFacts,
};
