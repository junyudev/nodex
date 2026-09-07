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
