import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type ReleaseDownloadAliasOptions = {
  arm64Dir: string;
  version: string;
  x64Dir: string;
};

const ARM64_ALIAS_FILENAME = "Nodex-latest-arm64.dmg";
const X64_ALIAS_FILENAME = "Nodex-latest-x64.dmg";

function normalizeRequiredValue(value: string | null, label: string): string {
  const normalized = value?.trim() ?? "";

  if (normalized.length === 0) {
    throw new Error(`Missing required value for ${label}.`);
  }

  return normalized;
}

function createAlias(sourcePath: string, aliasPath: string): void {
  if (!existsSync(sourcePath)) {
    throw new Error(`Expected source DMG at ${sourcePath}.`);
  }

  copyFileSync(sourcePath, aliasPath);
}

export function createReleaseDownloadAliases(options: ReleaseDownloadAliasOptions): {
  arm64AliasPath: string;
  x64AliasPath: string;
} {
  const version = normalizeRequiredValue(options.version, "--version");
  const arm64Dir = normalizeRequiredValue(options.arm64Dir, "--arm64-dir");
  const x64Dir = normalizeRequiredValue(options.x64Dir, "--x64-dir");
  const arm64SourcePath = resolve(arm64Dir, `Nodex-${version}-arm64.dmg`);
  const x64SourcePath = resolve(x64Dir, `Nodex-${version}-x64.dmg`);
  const arm64AliasPath = resolve(arm64Dir, ARM64_ALIAS_FILENAME);
  const x64AliasPath = resolve(x64Dir, X64_ALIAS_FILENAME);

  createAlias(arm64SourcePath, arm64AliasPath);
  createAlias(x64SourcePath, x64AliasPath);

  return { arm64AliasPath, x64AliasPath };
}

function parseCliOptions(argv: string[]): ReleaseDownloadAliasOptions {
  let version: string | null = null;
  let arm64Dir: string | null = null;
  let x64Dir: string | null = null;

  for (let index = 0; index < argv.length; ) {
    const argument = argv[index];

    if (argument === "--") {
      index += 1;
      continue;
    }

    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${argument}".`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }

    switch (argument) {
      case "--version":
        version = value;
        break;
      case "--arm64-dir":
        arm64Dir = resolve(value);
        break;
      case "--x64-dir":
        x64Dir = resolve(value);
        break;
      default:
        throw new Error(`Unknown argument "${argument}".`);
    }

    index += 2;
  }

  return {
    version: normalizeRequiredValue(version, "--version"),
    arm64Dir: normalizeRequiredValue(arm64Dir, "--arm64-dir"),
    x64Dir: normalizeRequiredValue(x64Dir, "--x64-dir"),
  };
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  createReleaseDownloadAliases(options);
}

if (import.meta.main) {
  main();
}
