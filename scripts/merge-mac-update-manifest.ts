import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dump, load } from "js-yaml";

interface UpdateFileInfo {
  url: string;
  sha512: string;
  [key: string]: unknown;
}

export interface MacUpdateManifest {
  version: string;
  files?: UpdateFileInfo[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
  releaseName?: string;
  releaseNotes?: unknown;
  [key: string]: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeFiles(manifest: MacUpdateManifest): UpdateFileInfo[] {
  if (Array.isArray(manifest.files) && manifest.files.length > 0) {
    return manifest.files
      .filter((entry): entry is UpdateFileInfo => {
        return typeof entry === "object"
          && entry !== null
          && isNonEmptyString(entry.url)
          && isNonEmptyString(entry.sha512);
      })
      .map((entry) => ({
        ...entry,
        url: entry.url.trim(),
        sha512: entry.sha512.trim(),
      }));
  }

  if (isNonEmptyString(manifest.path) && isNonEmptyString(manifest.sha512)) {
    return [{
      url: manifest.path.trim(),
      sha512: manifest.sha512.trim(),
    }];
  }

  throw new Error("Expected a mac update manifest with at least one file entry.");
}

function resolveFirstDefined<T>(manifests: MacUpdateManifest[], key: string): T | undefined {
  for (const manifest of manifests) {
    const value = manifest[key];
    if (value !== undefined && value !== null) {
      return value as T;
    }
  }

  return undefined;
}

export function mergeMacUpdateManifests(manifests: MacUpdateManifest[]): MacUpdateManifest {
  if (manifests.length < 2) {
    throw new Error("Expected at least two mac update manifests to merge.");
  }

  const baseManifest = manifests[0];
  if (!isNonEmptyString(baseManifest.version)) {
    throw new Error("Expected each mac update manifest to include a version.");
  }

  const mergedFiles: UpdateFileInfo[] = [];
  const seenUrls = new Set<string>();

  for (const manifest of manifests) {
    if (manifest.version !== baseManifest.version) {
      throw new Error(`Expected matching manifest versions, got ${baseManifest.version} and ${manifest.version}.`);
    }

    for (const file of normalizeFiles(manifest)) {
      if (seenUrls.has(file.url)) {
        continue;
      }

      seenUrls.add(file.url);
      mergedFiles.push(file);
    }
  }

  if (mergedFiles.length === 0) {
    throw new Error("Expected at least one merged update file.");
  }

  const legacyFile = mergedFiles.find((file) => file.url.endsWith(".zip")) ?? mergedFiles[0];

  return {
    ...baseManifest,
    version: baseManifest.version,
    files: mergedFiles,
    path: legacyFile.url,
    sha512: legacyFile.sha512,
    releaseDate: resolveFirstDefined<string>(manifests, "releaseDate"),
    releaseName: resolveFirstDefined<string>(manifests, "releaseName"),
    releaseNotes: resolveFirstDefined<unknown>(manifests, "releaseNotes"),
  };
}

export function mergeMacUpdateManifestFiles(inputPaths: string[], outputPath: string): MacUpdateManifest {
  const manifests = inputPaths.map((inputPath) => {
    const raw = readFileSync(inputPath, "utf8");
    const parsed = load(raw);

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`Expected ${inputPath} to contain a YAML object.`);
    }

    return parsed as MacUpdateManifest;
  });

  const merged = mergeMacUpdateManifests(manifests);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, dump(merged, { lineWidth: 120, noRefs: true }), "utf8");
  return merged;
}

function parseCliOptions(argv: string[]): { inputs: string[]; output: string } {
  const inputs: string[] = [];
  let output: string | null = null;

  for (let index = 0; index < argv.length; ) {
    const argument = argv[index];

    if (argument === "--") {
      index += 1;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }

    switch (argument) {
      case "--input":
        inputs.push(resolve(value));
        break;
      case "--output":
        output = resolve(value);
        break;
      default:
        throw new Error(`Unknown argument "${argument}".`);
    }

    index += 2;
  }

  if (inputs.length < 2) {
    throw new Error("Expected at least two --input manifest paths.");
  }

  if (!output) {
    throw new Error("Missing required --output path.");
  }

  return { inputs, output };
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  mergeMacUpdateManifestFiles(options.inputs, options.output);
}

if (import.meta.main) {
  main();
}
