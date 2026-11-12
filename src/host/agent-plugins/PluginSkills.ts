import * as Effect from "effect/Effect";
import { describePluginSkill } from "../../shared/agent-plugins/skill";
import type { AgentPluginSkill } from "../../shared/agent-plugins/types";
import type { PackageFiles } from "./PackageFiles";
import { declaredPath, readDocument, type Diagnose } from "./package-documents";

export const readPluginSkills = Effect.fnUntraced(function* (
  files: PackageFiles,
  layout: "portable-1.0.0" | "codex" | "claude",
  manifestPath: string,
  declaration: unknown,
  diagnose: Diagnose,
) {
  const directories = new Set<string>();
  const roots = new Map([["skills", false]]);
  if (layout === "codex" && declaration !== undefined) roots.clear();
  if (layout !== "portable-1.0.0" && declaration !== undefined) {
    for (const value of Array.isArray(declaration) ? declaration : [declaration]) {
      const path = declaredPath(value, manifestPath, "skills", diagnose, layout !== "claude");
      if (path) roots.set(path, true);
    }
  }
  for (const [root, declared] of roots) {
    const entry = files.inspect(root);
    if (entry.kind === "missing" && !declared && !files.hasEntry(root)) continue;
    if (entry.kind !== "directory") {
      diagnose({
        code:
          entry.kind === "unsafe" || entry.kind === "special" ? "unsafe-path" : "invalid-component",
        path: root,
        message: "Expected a skills directory inside the package.",
      });
      continue;
    }
    if (declared && files.inspect(root + "/SKILL.md").kind !== "missing") {
      directories.add(root);
      continue;
    }
    for (const name of files.children(entry.path)) {
      const directory = root + "/" + name;
      const child = files.inspect(directory);
      if (child.kind === "directory" || child.kind === "unsafe") directories.add(directory);
    }
  }
  const skills: AgentPluginSkill[] = [];
  for (const directory of [...directories].sort()) {
    const path = directory + "/SKILL.md";
    if (files.inspect(path).kind === "directory") continue;
    const document = yield* readDocument(files, path);
    if (document.status === "missing") continue;
    skills.push(
      document.status === "read"
        ? describePluginSkill(directory, path, document.value)
        : describePluginSkill(directory, path, undefined, {
            code: document.unsafe ? "unsafe-path" : "invalid-skill",
            path,
            message: document.message,
          }),
    );
  }
  return skills;
});
