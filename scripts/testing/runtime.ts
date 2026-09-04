import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeForSuite, suiteConfig, type SuiteId } from "../../config/test-suites.ts";
import { runCommand, type Command } from "../tooling/process.ts";

const require = createRequire(import.meta.url);

export function runtimeCommand(
  suite: SuiteId,
  args: readonly string[],
  context: Pick<Command, "cwd" | "env" | "signal">,
): Command {
  const electron = runtimeForSuite(suite) === "electron-node";
  return {
    ...context,
    command: electron ? (require("electron") as string) : process.execPath,
    args,
    env: { ...context.env, ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), NODE_ENV: "test" },
  };
}

export function vitestCommand(
  suite: SuiteId,
  args: readonly string[],
  related: boolean,
  context: Pick<Command, "cwd" | "env" | "signal">,
): Command {
  const entry = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  return runtimeCommand(
    suite,
    [
      entry,
      related ? "related" : "run",
      ...(related ? ["--run", "--passWithNoTests"] : []),
      ...args,
      "--config",
      suiteConfig(suite),
    ],
    context,
  );
}

export async function discoverSuite(
  suite: SuiteId,
  args: readonly string[],
  related: boolean,
  context: Pick<Command, "cwd" | "env" | "signal">,
): Promise<readonly string[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-test-discovery-"));
  try {
    const output = path.join(directory, "files.json");
    const command = runtimeCommand(
      suite,
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        path.join(import.meta.dirname, "discover-tests.mts"),
        suite,
        output,
        related ? "related" : "run",
        ...args,
      ],
      context,
    );
    const result = await runCommand(command);
    if (result.exitCode !== 0)
      throw new Error("Test discovery failed for " + suite + " (exit " + result.exitCode + ").");
    const files: unknown = JSON.parse(await readFile(output, "utf8"));
    if (!Array.isArray(files) || !files.every((file): file is string => typeof file === "string")) {
      throw new Error("Invalid test discovery result for " + suite + ".");
    }
    return files;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
