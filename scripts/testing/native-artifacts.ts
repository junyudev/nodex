import { runTimedCommand } from "../ci/run-timed.ts";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeArtifactId } from "../../config/test-suites.ts";
import { runCommand, type Command } from "../tooling/process.ts";

const targets = {
  "core-server": {
    package: "nodex-core-server",
    name: "nodex-core",
    kind: "bin",
    source: "crates/nodex-core-server/src/main.rs",
    environment: "NODEX_CORE_EXECUTABLE",
  },
  "yjs-yrs-bridge": {
    package: "nodex-core",
    name: "yjs_yrs_bridge",
    kind: "example",
    source: "crates/nodex-core/examples/yjs_yrs_bridge.rs",
    environment: "NODEX_YJS_YRS_BRIDGE_EXECUTABLE",
  },
} as const;

export interface PreparedNativeArtifacts {
  readonly executables: Readonly<Partial<Record<NativeArtifactId, string>>>;
}

export function cargoBuildArguments(artifacts: readonly NativeArtifactId[]): readonly string[] {
  const selected = [...new Set(artifacts)].map((id) => targets[id]);
  if (selected.length === 0) return [];
  return [
    "build",
    ...[...new Set(selected.map((target) => target.package))].flatMap((name) => ["-p", name]),
    ...selected.flatMap((target) => ["--" + target.kind, target.name]),
    "--message-format=json-render-diagnostics",
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Cargo owns freshness; the selected target's source and kind identify its executable. */
export function readCargoExecutables(
  output: string,
  artifacts: readonly NativeArtifactId[],
  repositoryRoot: string,
): PreparedNativeArtifacts {
  const messages: unknown[] = output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const executables: Partial<Record<NativeArtifactId, string>> = {};
  for (const id of new Set(artifacts)) {
    const expected = targets[id];
    const matches = messages.filter((message) => {
      if (!isRecord(message) || message.reason !== "compiler-artifact" || !isRecord(message.target))
        return false;
      const target = message.target;
      return (
        typeof message.package_id === "string" &&
        message.package_id.split("#")[0] ===
          "path+" + pathToFileURL(path.resolve(repositoryRoot, "crates", expected.package)).href &&
        target.name === expected.name &&
        Array.isArray(target.kind) &&
        target.kind.includes(expected.kind) &&
        typeof target.src_path === "string" &&
        path.resolve(target.src_path) === path.resolve(repositoryRoot, expected.source) &&
        typeof message.executable === "string" &&
        path.isAbsolute(message.executable)
      );
    });
    if (matches.length !== 1) {
      throw new Error("Cargo did not report exactly one executable for " + id + ".");
    }
    const match = matches[0] as { executable: string };
    executables[id] = match.executable;
  }
  return { executables };
}

export async function prepareNativeArtifacts(
  artifacts: readonly NativeArtifactId[],
  context: {
    readonly repositoryRoot: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly execute?: typeof runCommand;
  },
): Promise<PreparedNativeArtifacts> {
  const args = cargoBuildArguments(artifacts);
  if (args.length === 0) return { executables: {} };
  let output = "";
  process.stdout.write(
    "Preparing native test artifacts: " + [...new Set(artifacts)].join(", ") + "\n",
  );
  const command: Command = {
    command: "cargo",
    args,
    cwd: context.repositoryRoot,
    env: context.env,
    signal: context.signal,
    onStdout: (chunk) => {
      output += chunk;
    },
  };
  const result =
    context.execute || !context.env?.NODEX_TEST_TIMINGS
      ? await (context.execute ?? runCommand)(command)
      : await runTimedCommand({
          ...command,
          commandArguments: command.args,
          name: "native-prepare",
          timingDirectory: context.env.NODEX_TEST_TIMINGS,
        });
  if (result.exitCode !== 0)
    throw new Error("Native test preparation failed (exit " + result.exitCode + ").");
  process.stdout.write("Native preparation: " + (result.durationMs / 1000).toFixed(2) + "s\n");
  return readCargoExecutables(output, artifacts, context.repositoryRoot);
}

export function preparedNativeEnvironment(artifacts: PreparedNativeArtifacts): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(artifacts.executables).map(([id, executable]) => [
      targets[id as NativeArtifactId].environment,
      executable,
    ]),
  );
}

export function requiredNativeExecutable(
  artifact: NativeArtifactId,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[targets[artifact].environment];
  if (value && path.isAbsolute(value)) return value;
  throw new Error(
    "Missing prepared " +
      artifact +
      "; run vp run test:core-client, test:main, or test:integration.",
  );
}
