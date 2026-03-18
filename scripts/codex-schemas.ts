import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const schemasOutputPath = resolve(projectRoot, "src/shared/codex_schemas");
const require = createRequire(import.meta.url);

type CodexSchemasCommand = "generate" | "verify";

type CliOptions = {
  command: CodexSchemasCommand;
};

function resolveCodexLauncherPath(): string {
  const packageJsonPath = require.resolve("@openai/codex/package.json", {
    paths: [projectRoot],
  });
  return join(dirname(packageJsonPath), "bin", "codex.js");
}

function generateSchemas(outputPath: string): void {
  rmSync(outputPath, { recursive: true, force: true });
  execFileSync(
    "node",
    [
      resolveCodexLauncherPath(),
      "app-server",
      "generate-ts",
      "--experimental",
      "--out",
      outputPath,
    ],
    {
      cwd: projectRoot,
      stdio: "inherit",
    },
  );
}

function readDirectoryFileMap(rootPath: string): Map<string, string> {
  const result = new Map<string, string>();
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of readdirSync(current)) {
      const absolutePath = join(current, entry);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      const relativePath = relative(rootPath, absolutePath);
      result.set(relativePath, readFileSync(absolutePath, "utf8"));
    }
  }

  return result;
}

export function verifySchemas(): void {
  const tempDir = mkdtempSync(join(tmpdir(), "nodex-codex-schemas-"));

  try {
    generateSchemas(tempDir);
    const expected = readDirectoryFileMap(schemasOutputPath);
    const actual = readDirectoryFileMap(tempDir);

    if (expected.size !== actual.size) {
      throw new Error(
        `Committed codex_schemas are out of date: expected ${expected.size} files, got ${actual.size}. Run bun run codex:schemas:generate.`,
      );
    }

    for (const [relativePath, expectedContent] of expected.entries()) {
      const actualContent = actual.get(relativePath);
      if (actualContent === undefined) {
        throw new Error(`Committed codex_schemas are missing ${relativePath}. Run bun run codex:schemas:generate.`);
      }
      if (actualContent !== expectedContent) {
        throw new Error(`Committed codex_schemas differ at ${relative(projectRoot, join(schemasOutputPath, relativePath))}. Run bun run codex:schemas:generate.`);
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseCliOptions(argv: string[]): CliOptions {
  const args = argv.filter((value) => value !== "--");
  const command = args[0];

  if (command !== "generate" && command !== "verify") {
    throw new Error('Expected "generate" or "verify".');
  }

  if (args.length > 1) {
    throw new Error(`Unexpected extra arguments: ${args.slice(1).join(" ")}`);
  }

  return { command };
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.command === "generate") {
    generateSchemas(schemasOutputPath);
    return;
  }

  verifySchemas();
  console.log("Committed codex_schemas match the pinned Codex version.");
}

if (import.meta.main) {
  main();
}
