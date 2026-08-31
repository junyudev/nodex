import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT_FILE = join(
  REPOSITORY_ROOT,
  ".generated/build-resources/THIRD_PARTY_NOTICES.txt",
);
const LEGAL_FILENAME_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const DIVIDER = "=".repeat(80);
interface PnpmLicensePackage {
  author?: string;
  homepage?: string;
  license?: string;
  name: string;
  paths: string[];
  versions: string[];
}

type PnpmLicenseReport = Record<string, PnpmLicensePackage[]>;

interface PackageManifest {
  os?: string[];
}

interface CargoMetadata {
  packages: Array<{
    homepage: string | null;
    license: string | null;
    manifest_path: string;
    name: string;
    repository: string | null;
    source: string | null;
    version: string;
  }>;
}

export interface ThirdPartyLegalEntry {
  homepage: string | null;
  identity: string;
  legalText: string | null;
  license: string;
}

export interface ThirdPartyNoticesGenerationOptions {
  readonly repositoryRoot?: string;
}

function normalizeText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

async function readLegalDocuments(directory: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const filenames = entries
    .filter((entry) => entry.isFile() && LEGAL_FILENAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (filenames.length === 0) return null;

  const documents = await Promise.all(
    filenames.map(async (filename) => {
      const text = normalizeText(await readFile(join(directory, filename), "utf8"));
      return `--- ${filename} ---\n\n${text}`;
    }),
  );
  return documents.join("\n\n");
}

export function packageSupportsTargetOs(
  supportedOs: readonly string[] | undefined,
  targetOs: string,
): boolean {
  if (!supportedOs || supportedOs.length === 0) return true;

  const excluded = new Set(
    supportedOs.filter((value) => value.startsWith("!")).map((value) => value.slice(1)),
  );
  if (excluded.has(targetOs)) return false;

  const included = supportedOs.filter((value) => !value.startsWith("!"));
  return included.length === 0 || included.includes(targetOs);
}

async function packageDirectorySupportsTargetOs(
  packageDirectory: string,
  targetOs: string,
): Promise<boolean> {
  const manifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  ) as PackageManifest;
  return packageSupportsTargetOs(manifest.os, targetOs);
}

async function collectPnpmEntries(repositoryRoot: string): Promise<ThirdPartyLegalEntry[]> {
  const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const { stdout } = await execFileAsync(pnpmExecutable, ["licenses", "list", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(stdout) as PnpmLicenseReport;
  const entries: ThirdPartyLegalEntry[] = [];

  for (const [licenseGroup, packages] of Object.entries(report)) {
    for (const packageRecord of packages) {
      const packageEntries = (
        await Promise.all(
          packageRecord.paths.map(
            async (packageDirectory, index): Promise<ThirdPartyLegalEntry | null> => {
              if (!(await packageDirectorySupportsTargetOs(packageDirectory, "darwin"))) {
                return null;
              }

              return {
                homepage: packageRecord.homepage?.trim() || null,
                identity: `${packageRecord.name}@${packageRecord.versions[index] ?? "unknown"}`,
                legalText: await readLegalDocuments(packageDirectory),
                license: packageRecord.license?.trim() || licenseGroup,
              };
            },
          ),
        )
      ).filter((entry): entry is ThirdPartyLegalEntry => entry !== null);

      if (packageRecord.paths.length > 0) {
        entries.push(...packageEntries);
        continue;
      }

      entries.push({
        homepage: packageRecord.homepage?.trim() || null,
        identity: `${packageRecord.name}@${packageRecord.versions.join(", ") || "unknown"}`,
        legalText: null,
        license: packageRecord.license?.trim() || licenseGroup,
      });
    }
  }

  return entries;
}

async function collectCargoEntries(repositoryRoot: string): Promise<ThirdPartyLegalEntry[]> {
  const { stdout } = await execFileAsync(
    "cargo",
    ["metadata", "--format-version", "1", "--locked"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const metadata = JSON.parse(stdout) as CargoMetadata;
  const thirdPartyPackages = metadata.packages.filter(
    (packageRecord) => packageRecord.source !== null,
  );

  return await Promise.all(
    thirdPartyPackages.map(async (packageRecord) => ({
      homepage: packageRecord.homepage?.trim() || packageRecord.repository?.trim() || null,
      identity: `${packageRecord.name}@${packageRecord.version} (Rust crate)`,
      legalText: await readLegalDocuments(dirname(packageRecord.manifest_path)),
      license: packageRecord.license?.trim() || "Not declared",
    })),
  );
}

async function readCombinedLegalFiles(paths: string[]): Promise<string | null> {
  const documents: string[] = [];

  for (const filePath of paths) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const text = normalizeText(await readFile(filePath, "utf8"));
    documents.push(`--- ${filePath.split(/[\\/]/).at(-1) ?? "NOTICE"} ---\n\n${text}`);
  }

  return documents.length > 0 ? documents.join("\n\n") : null;
}

async function collectBundledRuntimeEntries(
  repositoryRoot: string,
): Promise<ThirdPartyLegalEntry[]> {
  const codexRoot = join(repositoryRoot, "resources", "third-party", "codex");

  return [
    {
      homepage: "https://sparkle-project.org/",
      identity: "Sparkle 2.9.4",
      legalText: await readCombinedLegalFiles([
        join(repositoryRoot, "resources", "sparkle", "LICENSE"),
      ]),
      license: "MIT and bundled third-party notices",
    },
    {
      homepage: "https://github.com/openai/codex",
      identity: "Codex app-server runtime",
      legalText: await readCombinedLegalFiles([
        join(codexRoot, "LICENSE"),
        join(codexRoot, "NOTICE"),
      ]),
      license: "Apache-2.0",
    },
  ];
}

function groupKey(entry: ThirdPartyLegalEntry): string {
  if (!entry.legalText) return `missing:${entry.license}`;
  return createHash("sha256").update(entry.legalText).digest("hex");
}

function renderEntry(entry: ThirdPartyLegalEntry): string {
  const homepage = entry.homepage ? ` — ${entry.homepage}` : "";
  return `- ${entry.identity} — ${entry.license}${homepage}`;
}

export function renderThirdPartyNotices(entries: ThirdPartyLegalEntry[]): string {
  const deduplicated = new Map<string, ThirdPartyLegalEntry>();
  for (const entry of entries) {
    deduplicated.set(`${entry.identity}\u0000${entry.license}`, entry);
  }

  const grouped = new Map<string, ThirdPartyLegalEntry[]>();
  for (const entry of deduplicated.values()) {
    const key = groupKey(entry);
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }

  const sections = [...grouped.values()]
    .map((group) => group.sort((left, right) => left.identity.localeCompare(right.identity)))
    .sort((left, right) => (left[0]?.identity ?? "").localeCompare(right[0]?.identity ?? ""))
    .map((group) => {
      const packageList = group.map(renderEntry).join("\n");
      const legalText =
        group[0]?.legalText ??
        "No separate license or notice file was published with these package artifacts. The declared license identifiers are listed above.";
      return `${DIVIDER}\n${packageList}\n${DIVIDER}\n\n${legalText}`;
    });

  return [
    "NODEX THIRD-PARTY NOTICES",
    "",
    "This document lists licenses and notices for third-party software used to build and run Nodex. Identical legal texts are emitted once for all packages that share them.",
    "",
    ...sections,
    "",
  ].join("\n");
}

export async function generateThirdPartyNotices(
  options: ThirdPartyNoticesGenerationOptions = {},
): Promise<string> {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const [pnpmEntries, cargoEntries, runtimeEntries] = await Promise.all([
    collectPnpmEntries(repositoryRoot),
    collectCargoEntries(repositoryRoot),
    collectBundledRuntimeEntries(repositoryRoot),
  ]);
  return renderThirdPartyNotices([...pnpmEntries, ...cargoEntries, ...runtimeEntries]);
}

function parseArguments(args: string[]): { outputFile: string; verify: boolean } {
  const outputFileIndex = args.indexOf("--output-file");
  const outputFile = outputFileIndex >= 0 ? args[outputFileIndex + 1] : DEFAULT_OUTPUT_FILE;
  if (!outputFile) throw new Error("--output-file requires a path");

  return {
    outputFile: resolve(REPOSITORY_ROOT, outputFile),
    verify: args.includes("--verify"),
  };
}

async function main(): Promise<void> {
  const { outputFile, verify } = parseArguments(process.argv.slice(2));
  const generated = await generateThirdPartyNotices({ repositoryRoot: REPOSITORY_ROOT });

  if (verify) {
    const existing = await readFile(outputFile, "utf8").catch(() => null);
    if (existing !== generated) {
      throw new Error(`${outputFile} is stale. Run \"pnpm run build-resources:prepare\".`);
    }
    return;
  }

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, generated, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
