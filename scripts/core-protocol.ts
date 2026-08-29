import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Command = "generate" | "verify";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const packageRoot = join(repositoryRoot, "packages/core-protocol");
const codegenPackageRoot = join(repositoryRoot, "packages/core-protocol-codegen");
const committedOpenApi = join(packageRoot, "openapi.json");
const committedTypes = join(packageRoot, "src/generated.ts");
const committedRequirements = join(packageRoot, "src/compatibility.generated.ts");

interface GeneratedArtifacts {
  readonly openApi: string;
  readonly types: string;
  readonly requirements: string;
}

function run(command: string, args: readonly string[], cwd = repositoryRoot): void {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
  });
}

function generateArtifacts(directory: string): GeneratedArtifacts {
  const openApi = join(directory, "openapi.json");
  const types = join(directory, "generated.ts");
  const requirements = join(directory, "compatibility.generated.ts");

  run("cargo", [
    "run",
    "--quiet",
    "-p",
    "nodex-core-protocol",
    "--bin",
    "generate-openapi",
    "--",
    "--output",
    openApi,
    "--requirements-output",
    requirements,
  ]);
  run(
    "pnpm",
    ["exec", "openapi-typescript", openApi, "--output", types, "--alphabetize", "--immutable"],
    codegenPackageRoot,
  );

  return { openApi, types, requirements };
}

function assertSame(expectedPath: string, actualPath: string): void {
  const expected = readFileSync(expectedPath);
  const actual = readFileSync(actualPath);
  if (expected.equals(actual)) return;

  throw new Error(
    `Generated Core protocol differs at ${expectedPath}. Run pnpm run core:protocol:generate.`,
  );
}

export function generateProtocol(): void {
  const staging = mkdtempSync(join(tmpdir(), "nodex-core-protocol-"));
  try {
    const artifacts = generateArtifacts(staging);
    mkdirSync(dirname(committedTypes), { recursive: true });
    copyFileSync(artifacts.openApi, committedOpenApi);
    copyFileSync(artifacts.types, committedTypes);
    copyFileSync(artifacts.requirements, committedRequirements);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function verifyProtocol(): void {
  const staging = mkdtempSync(join(tmpdir(), "nodex-core-protocol-"));
  try {
    const artifacts = generateArtifacts(staging);
    assertSame(committedOpenApi, artifacts.openApi);
    assertSame(committedTypes, artifacts.types);
    assertSame(committedRequirements, artifacts.requirements);
    run("cargo", [
      "test",
      "--quiet",
      "-p",
      "nodex-core",
      "--lib",
      "infrastructure::schema::tests::current_schema_artifact_matches_catalog",
      "--",
      "--exact",
    ]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseCommand(argv: readonly string[]): Command {
  const args = argv.filter((value) => value !== "--");
  if (args.length === 1 && (args[0] === "generate" || args[0] === "verify")) {
    return args[0];
  }
  throw new Error('Expected exactly one command: "generate" or "verify".');
}

function main(): void {
  const command = parseCommand(process.argv.slice(2));
  if (command === "generate") {
    generateProtocol();
    return;
  }
  verifyProtocol();
  console.log("Committed Core OpenAPI and TypeScript types are current.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
