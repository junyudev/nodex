import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

type SupportedTargetPlatform = "darwin";
type SupportedTargetArch = "arm64" | "x64";

type CodexRuntimeTarget = {
  packageName: string;
  targetArch: SupportedTargetArch;
  targetPlatform: SupportedTargetPlatform;
  targetTriple: string;
};

export type BundledCodexRuntimeMetadata = {
  binarySha256: string;
  codexVersion: string;
  rgSha256: string;
  sourcePackage: string;
  targetArch: SupportedTargetArch;
  targetPlatform: SupportedTargetPlatform;
  targetTriple: string;
};

type StageCodexRuntimeOptions = {
  outputPath: string;
  packageRoot?: string;
  targetArch: SupportedTargetArch;
  targetPlatform: SupportedTargetPlatform;
};

type CliOptions = StageCodexRuntimeOptions;

export function resolveCodexRuntimeTarget(
  targetPlatform: SupportedTargetPlatform,
  targetArch: SupportedTargetArch,
): CodexRuntimeTarget {
  if (targetPlatform === "darwin" && targetArch === "arm64") {
    return {
      packageName: "@openai/codex-darwin-arm64",
      targetPlatform,
      targetArch,
      targetTriple: "aarch64-apple-darwin",
    };
  }

  if (targetPlatform === "darwin" && targetArch === "x64") {
    return {
      packageName: "@openai/codex-darwin-x64",
      targetPlatform,
      targetArch,
      targetTriple: "x86_64-apple-darwin",
    };
  }

  throw new Error(`Unsupported Codex runtime target: ${targetPlatform}/${targetArch}`);
}

function resolveCodexRuntimePackageRoot(packageName: string): string {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, {
      paths: [projectRoot],
    });
    return dirname(packageJsonPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not resolve ${packageName} from node_modules. Install dependencies on a matching target architecture before packaging this runtime. Underlying error: ${message}`,
    );
  }
}

function readPackageVersion(packageRoot: string): string {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
    throw new Error(`Invalid package version in ${packageJsonPath}`);
  }
  return packageJson.version;
}

function readSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function replaceDirectory(sourceDir: string, destinationDir: string): void {
  rmSync(destinationDir, { recursive: true, force: true });
  renameSync(sourceDir, destinationDir);
}

export function stageCodexRuntime(options: StageCodexRuntimeOptions): BundledCodexRuntimeMetadata {
  const target = resolveCodexRuntimeTarget(options.targetPlatform, options.targetArch);
  const packageRoot = options.packageRoot ? resolve(options.packageRoot) : resolveCodexRuntimePackageRoot(target.packageName);
  const packageVersion = readPackageVersion(packageRoot);
  const vendorRoot = join(packageRoot, "vendor", target.targetTriple);
  const codexSourcePath = join(vendorRoot, "codex", "codex");
  const rgSourcePath = join(vendorRoot, "path", "rg");

  if (!existsSync(codexSourcePath)) {
    throw new Error(`Missing bundled Codex binary at ${codexSourcePath}`);
  }
  if (!existsSync(rgSourcePath)) {
    throw new Error(`Missing bundled rg binary at ${rgSourcePath}`);
  }

  const outputPath = resolve(options.outputPath);
  const outputParent = dirname(outputPath);
  mkdirSync(outputParent, { recursive: true });
  const tempOutputPath = mkdtempSync(join(outputParent, `${basename(outputPath)}-`));
  const tempPathDir = join(tempOutputPath, "path");

  mkdirSync(tempPathDir, { recursive: true });
  copyFileSync(codexSourcePath, join(tempOutputPath, "codex"));
  copyFileSync(rgSourcePath, join(tempPathDir, "rg"));
  chmodSync(join(tempOutputPath, "codex"), 0o755);
  chmodSync(join(tempPathDir, "rg"), 0o755);

  const metadata: BundledCodexRuntimeMetadata = {
    codexVersion: packageVersion.replace(/-(darwin-(arm64|x64))$/, ""),
    targetPlatform: target.targetPlatform,
    targetArch: target.targetArch,
    targetTriple: target.targetTriple,
    sourcePackage: `${target.packageName}@${packageVersion}`,
    binarySha256: readSha256(join(tempOutputPath, "codex")),
    rgSha256: readSha256(join(tempPathDir, "rg")),
  };

  writeFileSync(join(tempOutputPath, "runtime.json"), JSON.stringify(metadata, null, 2), "utf8");

  try {
    replaceDirectory(tempOutputPath, outputPath);
  } finally {
    rmSync(tempOutputPath, { recursive: true, force: true });
  }

  return metadata;
}

function parseCliOptions(argv: string[]): CliOptions {
  const args = argv.filter((value) => value !== "--");
  let targetPlatform: SupportedTargetPlatform | null = null;
  let targetArch: SupportedTargetArch | null = null;
  let outputPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = args[index + 1];

    if (arg === "--target-platform") {
      if (nextValue !== "darwin") {
        throw new Error(`Unsupported --target-platform value: ${nextValue ?? "<missing>"}`);
      }
      targetPlatform = nextValue;
      index += 1;
      continue;
    }

    if (arg === "--target-arch") {
      if (nextValue !== "arm64" && nextValue !== "x64") {
        throw new Error(`Unsupported --target-arch value: ${nextValue ?? "<missing>"}`);
      }
      targetArch = nextValue;
      index += 1;
      continue;
    }

    if (arg === "--out") {
      if (!nextValue) {
        throw new Error("Missing value for --out");
      }
      outputPath = nextValue;
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!targetPlatform || !targetArch || !outputPath) {
    throw new Error("Usage: bun run scripts/stage-codex-runtime.ts --target-platform darwin --target-arch <arm64|x64> --out <dir>");
  }

  return {
    targetPlatform,
    targetArch,
    outputPath: resolve(projectRoot, outputPath),
  };
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const metadata = stageCodexRuntime(options);
  console.log(`Staged Codex runtime ${metadata.sourcePackage} to ${options.outputPath}`);
}

if (import.meta.main) {
  main();
}
