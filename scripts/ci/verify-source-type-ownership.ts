import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "../..");
const vpExecutable = process.platform === "win32" ? "vp.cmd" : "vp";
const rawFixtureDirectories = [
  "scripts/fixtures/tooling/",
  "scripts/fixtures/effect-boundaries/",
  "scripts/fixtures/renderer-command-boundaries/",
];

function sourceFileInventory(directory: string): readonly string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: directory,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not enumerate source files: ${result.stderr}`);
  return result.stdout.split("\0");
}

/** Every owned TypeScript file must appear in a real compiler project graph. */
export function verifySourceTypeOwnership(
  directory = projectRoot,
  sourceFiles: readonly string[] = sourceFileInventory(directory),
): void {
  const canonicalDirectory = realpathSync(directory);
  const solution = JSON.parse(
    readFileSync(resolve(canonicalDirectory, "tsconfig.json"), "utf8"),
  ) as {
    readonly references: readonly { readonly path: string }[];
  };
  const covered = new Set<string>();
  for (const reference of solution.references) {
    const result = spawnSync(
      vpExecutable,
      ["exec", "tsc-rs", "--project", reference.path, "--listFilesOnly"],
      {
        cwd: canonicalDirectory,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Could not enumerate ${reference.path}: ${result.stdout}${result.stderr}`);
    }
    for (const filename of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      covered.add(
        relative(canonicalDirectory, resolve(canonicalDirectory, filename)).replaceAll("\\", "/"),
      );
    }
  }
  const missing = sourceFiles.filter(
    (filename) =>
      /\.(?:ts|tsx|mts|cts)$/u.test(filename) &&
      !rawFixtureDirectories.some((prefix) => filename.startsWith(prefix)) &&
      existsSync(resolve(canonicalDirectory, filename)) &&
      !covered.has(filename),
  );
  if (missing.length === 0) return;
  throw new Error(`TypeScript source files lack a compiler project owner:\n${missing.join("\n")}`);
}

/** Traverse owned fixture sources without descending into dependency links. */
function fixtureSourceFiles(directory: string, prefix = ""): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || entry.name === "node_modules") return [];
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return fixtureSourceFiles(join(directory, entry.name), name);
    return entry.isFile() ? [name] : [];
  });
}

/** Compiler discovery rejects unowned files, shadowed extensions, and runnable fixture omissions. */
export function verifySourceTypeOwnershipFixtures(): void {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nodex-source-type-ownership-")));
  try {
    symlinkSync(resolve(projectRoot, "node_modules"), join(directory, "node_modules"), "junction");
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true, packageManager: "pnpm@12.3.4" }),
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "./tsconfig.source.json" }] }),
    );
    writeFileSync(
      join(directory, "tsconfig.source.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true, types: [], jsx: "preserve" },
        include: ["owned/**/*"],
      }),
    );
    mkdirSync(join(directory, "owned"));
    writeFileSync(join(directory, "owned/initial.ts"), "export const initial = 1;\n");
    for (const rawFixtureDirectory of rawFixtureDirectories) {
      mkdirSync(join(directory, rawFixtureDirectory), { recursive: true });
      writeFileSync(
        join(directory, rawFixtureDirectory, "invalid.ts"),
        "export const invalid: number = 'wrong';\n",
      );
    }
    const verify = () => verifySourceTypeOwnership(directory, fixtureSourceFiles(directory));
    const expectUnowned = (filename: string) => {
      try {
        verify();
      } catch (error) {
        if (error instanceof Error && error.message.split("\n").includes(filename)) return;
        throw error;
      }
      throw new Error(`Unowned source fixture unexpectedly passed: ${filename}`);
    };
    verify();
    writeFileSync(join(directory, "unowned.ts"), "export const unowned = 2;\n");
    expectUnowned("unowned.ts");
    rmSync(join(directory, "unowned.ts"));
    writeFileSync(join(directory, "scripts/fixtures/runnable.ts"), "export const runnable = 3;\n");
    expectUnowned("scripts/fixtures/runnable.ts");
    rmSync(join(directory, "scripts/fixtures/runnable.ts"));
    writeFileSync(join(directory, "owned/pair.ts"), "export const first = 1;\n");
    writeFileSync(join(directory, "owned/pair.tsx"), "export const second = 2;\n");
    expectUnowned("owned/pair.tsx");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  verifySourceTypeOwnership();
  console.log("TypeScript source files have compiler project owners.");
}
