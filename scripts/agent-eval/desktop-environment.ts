import { writeFile } from "node:fs/promises";
import path from "node:path";

/** Prepare a disposable workspace; CLI task routing is supplied by the ordinary Desktop host. */
export async function prepareDesktopEnvironment(input: {
  repository: string;
  workspace: string;
  nodexHome: string;
  codexHome: string;
  projectId: string;
}) {
  const binary = path.join(input.repository, "target/debug/nodex");
  const environment = {
    NODEX_HOME: input.nodexHome,
    NODEX_CORE_BINARY: path.join(input.repository, "target/debug/nodex-core"),
    NODEX_RG_BINARY: path.join(
      input.repository,
      ".generated/codex-runtime/agent-runtime/codex-path/rg",
    ),
  };
  await writeFile(
    path.join(input.workspace, "AGENTS.md"),
    [
      "# Development task workspace",
      "",
      "This workspace belongs to a seeded Nodex development instance.",
      `The expected Project is ${input.projectId}. Use the Nodex connection supplied by the host.`,
      "Check nodex context before working; stop if it identifies another Project. Do not switch to the production Nodex Profile.",
      "Complete this task through the public Nodex CLI and its published Skill, references and help. Ordinary shell tools, files, pipes and scripts are available for processing CLI input/output.",
      "If that interface cannot express the request, report the precise missing capability and any completed work, then end the task. Do not create a misleading partial result.",
      "Repository source inspection, private APIs, direct Store access, computer-use and browser automation are outside this CLI evaluation. Tool availability does not authorize another route. Do not inspect or control any desktop window.",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(input.codexHome, "config.toml"),
    [
      "[shell_environment_policy]",
      'inherit = "all"',
      "",
      "[shell_environment_policy.set]",
      ...Object.entries(environment).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { environment, binary };
}
