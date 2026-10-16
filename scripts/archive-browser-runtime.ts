import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_RUNTIME_MANIFEST_FILENAME } from "../src/shared/browser-runtime-metadata";
import {
  assertBrowserRuntimeSourceClosure,
  readBrowserRuntimeFileSha256,
  readBrowserRuntimeSourceManifest,
} from "./stage-browser-runtime";

type ArchiveBrowserRuntimeOptions = {
  outputPath: string;
  sourceRoot: string;
};

export type BrowserRuntimeArchiveMetadata = {
  archiveSha256: string;
  archiveSize: number;
  assetName: string;
  manifestSha256: string;
  targetArch: "arm64";
};

export function archiveBrowserRuntime(
  options: ArchiveBrowserRuntimeOptions,
): BrowserRuntimeArchiveMetadata {
  const sourceRoot = path.resolve(options.sourceRoot);
  const outputPath = path.resolve(options.outputPath);
  const sourceStats = lstatSync(sourceRoot);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error(`Browser runtime source must be a real directory: ${sourceRoot}`);
  }
  if (outputPath === sourceRoot || outputPath.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new Error("Browser runtime archive must be written outside the source closure");
  }

  const manifest = readBrowserRuntimeSourceManifest(sourceRoot);
  if (manifest.targetPlatform !== "darwin" || manifest.targetArch !== "arm64") {
    throw new Error("Browser runtime releases require macOS arm64");
  }
  assertBrowserRuntimeSourceClosure(sourceRoot, manifest);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.part-${process.pid}`;
  try {
    execFileSync("tar", ["-czf", temporaryPath, "-C", sourceRoot, "."]);
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }

  const archiveStats = lstatSync(outputPath);
  return {
    archiveSha256: readBrowserRuntimeFileSha256(outputPath),
    archiveSize: archiveStats.size,
    assetName: path.basename(outputPath),
    manifestSha256: readBrowserRuntimeFileSha256(
      path.join(sourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME),
    ),
    targetArch: manifest.targetArch,
  };
}

function parseCliOptions(argv: string[]): ArchiveBrowserRuntimeOptions {
  const args = argv.filter((value) => value !== "--");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Browser runtime archive arguments must be --key value pairs");
    }
    values.set(key, value);
  }
  const sourceRoot = values.get("--source");
  const outputPath = values.get("--out");
  if (!sourceRoot || !outputPath) {
    throw new Error("Usage: archive-browser-runtime.ts --source <directory> --out <tar.gz>");
  }
  return { outputPath, sourceRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const metadata = archiveBrowserRuntime(parseCliOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
