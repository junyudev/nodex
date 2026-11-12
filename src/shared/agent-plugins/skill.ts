import { readSkillHeader } from "../skill-document/frontmatter";
import type { AgentPluginDiagnostic, AgentPluginSkill } from "./types";

export function describePluginSkill(
  directory: string,
  path: string,
  markdown: string | undefined,
  problem?: AgentPluginDiagnostic,
): AgentPluginSkill {
  const basename = directory.split("/").at(-1)!;
  let header: ReturnType<typeof readSkillHeader> | undefined;
  if (markdown !== undefined) {
    try {
      header = readSkillHeader(markdown);
    } catch {
      problem = { code: "invalid-skill", path, message: "Could not parse the skill frontmatter." };
    }
  }
  const name = header?.fields.name.value;
  const description = header?.fields.description.value ?? "";
  const issues = header?.reason ? [{ message: header.reason }] : [...(header?.formatIssues ?? [])];
  if (header && !header.reason) {
    if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name !== basename)
      issues.push({
        field: "name",
        message: "Expected a valid skill name matching its directory.",
      });
    if (!description.trim() || !/^.{1,1024}$/su.test(description))
      issues.push({
        field: "description",
        message: "Expected a description of 1–1024 characters.",
      });
  }
  const diagnostics: AgentPluginDiagnostic[] = [
    ...(problem ? [problem] : []),
    ...issues.map((issue): AgentPluginDiagnostic => ({ ...issue, path, code: "invalid-skill" })),
  ];
  return {
    name: name ?? basename,
    description,
    directory,
    valid: diagnostics.length === 0,
    diagnostics,
  };
}
