import fs from "node:fs";
import path from "node:path";

export type CodexRuntimeSource = "bundled" | "staged";

export type BundledCodexRuntimeMetadata = {
  binarySha256: string;
  codexVersion: string;
  rgSha256: string;
  sourcePackage: string;
  targetArch: string;
  targetPlatform: string;
  targetTriple: string;
};

export type ResolvedCodexRuntime = {
  additionalSearchPaths: string[];
  binaryPath: string;
  metadataPath: string | null;
  missingBinaryMessage: string;
  source: CodexRuntimeSource;
  version: string | null;
};

type ResolveCodexRuntimeOptions = {
  isPackaged: boolean;
  projectRootPath?: string;
  resourcesPath?: string;
};

function resolveRuntimeFromRoot(input: {
  missingBinaryMessage: string;
  runtimeRoot: string;
  source: CodexRuntimeSource;
}): ResolvedCodexRuntime {
  const binaryPath = path.join(input.runtimeRoot, "codex");
  const rgPath = path.join(input.runtimeRoot, "rg");
  const metadataPath = path.join(input.runtimeRoot, "runtime.json");

  if (!fs.existsSync(binaryPath) || !fs.existsSync(rgPath) || !fs.existsSync(metadataPath)) {
    throw new Error(`Codex runtime is missing or incomplete under ${input.runtimeRoot}`);
  }

  const metadata = parseBundledRuntimeMetadata(metadataPath);

  return {
    source: input.source,
    binaryPath,
    additionalSearchPaths: [input.runtimeRoot],
    version: metadata.codexVersion,
    metadataPath,
    missingBinaryMessage: input.missingBinaryMessage,
  };
}

function parseBundledRuntimeMetadata(metadataPath: string): BundledCodexRuntimeMetadata {
  const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Partial<BundledCodexRuntimeMetadata>;

  if (
    typeof parsed.codexVersion !== "string" ||
    typeof parsed.sourcePackage !== "string" ||
    typeof parsed.targetPlatform !== "string" ||
    typeof parsed.targetArch !== "string" ||
    typeof parsed.targetTriple !== "string" ||
    typeof parsed.binarySha256 !== "string" ||
    typeof parsed.rgSha256 !== "string"
  ) {
    throw new Error(`Invalid bundled Codex runtime metadata at ${metadataPath}`);
  }

  return {
    codexVersion: parsed.codexVersion,
    sourcePackage: parsed.sourcePackage,
    targetPlatform: parsed.targetPlatform,
    targetArch: parsed.targetArch,
    targetTriple: parsed.targetTriple,
    binarySha256: parsed.binarySha256,
    rgSha256: parsed.rgSha256,
  };
}

export function resolveCodexRuntime(options: ResolveCodexRuntimeOptions): ResolvedCodexRuntime {
  if (!options.isPackaged) {
    const projectRootPath = options.projectRootPath?.trim();
    if (!projectRootPath) {
      throw new Error("Unpackaged Codex runtime resolution requires a project root path");
    }

    return resolveRuntimeFromRoot({
      source: "staged",
      runtimeRoot: path.join(projectRootPath, ".generated", "codex-runtime", "bin"),
      missingBinaryMessage: "Pinned Codex runtime is missing or incomplete. Run `bun run stage:codex-runtime:mac`.",
    });
  }

  const resourcesPath = options.resourcesPath?.trim();
  if (!resourcesPath) {
    throw new Error("Packaged Codex runtime resolution requires process.resourcesPath");
  }

  return resolveRuntimeFromRoot({
    source: "bundled",
    runtimeRoot: path.join(resourcesPath, "bin"),
    missingBinaryMessage: "Bundled Codex runtime is missing or corrupted. Reinstall Nodex.",
  });
}
