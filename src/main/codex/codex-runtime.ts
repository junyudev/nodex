import fs from "node:fs";
import path from "node:path";

export type CodexRuntimeSource = "bundled" | "system";

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
  resourcesPath?: string;
};

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
    return {
      source: "system",
      binaryPath: "codex",
      additionalSearchPaths: [],
      version: null,
      metadataPath: null,
      missingBinaryMessage: "Could not find 'codex' in PATH or common install directories",
    };
  }

  const resourcesPath = options.resourcesPath?.trim();
  if (!resourcesPath) {
    throw new Error("Packaged Codex runtime resolution requires process.resourcesPath");
  }

  const runtimeRoot = path.join(resourcesPath, "codex");
  const binaryPath = path.join(runtimeRoot, "codex");
  const rgPath = path.join(runtimeRoot, "path", "rg");
  const metadataPath = path.join(runtimeRoot, "runtime.json");

  if (!fs.existsSync(binaryPath) || !fs.existsSync(rgPath) || !fs.existsSync(metadataPath)) {
    throw new Error(`Bundled Codex runtime is missing or incomplete under ${runtimeRoot}`);
  }

  const metadata = parseBundledRuntimeMetadata(metadataPath);

  return {
    source: "bundled",
    binaryPath,
    additionalSearchPaths: [path.dirname(rgPath)],
    version: metadata.codexVersion,
    metadataPath,
    missingBinaryMessage: "Bundled Codex runtime is missing or corrupted. Reinstall Nodex.",
  };
}
