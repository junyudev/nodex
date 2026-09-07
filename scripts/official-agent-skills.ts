import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { NESTED_MARKDOWN_AGENT_GUIDE } from "../src/shared/nfm/agent-guide";
import { parseNfm } from "../src/shared/nfm/parser";
import { serializeNfm } from "../src/shared/nfm/serializer";

const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const GENERATED_ROOT = ".generated";
const DEFAULT_OUTPUT_RELATIVE = join(GENERATED_ROOT, "official-agent-skills");
const AUTHORING_SKILL_RELATIVE = join("agent-skills", "nodex");
const SKILL_OUTPUT_PREFIX = "skills/nodex";
const MAX_FILE_BYTES = 128 * 1024;
const MAX_SKILL_BYTES = 512 * 1024;
const MAX_SKILL_LINES = 500;

export const OFFICIAL_SKILL_FILES = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/nested-markdown.md",
  "references/page-editor.md",
  "references/project-database-views.md",
  "references/queries-and-configuration.md",
  "references/troubleshooting.md",
] as const;

const OUTPUT_TOP_LEVEL_FILES = ["LICENSE", "README.md", "release-manifest.json"] as const;

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
}

export interface OfficialAgentSkillsOptions {
  readonly repositoryRoot?: string;
  readonly outputDirectory?: string;
  readonly sourceRepository?: string;
  readonly sourceRef?: string;
}

export interface OfficialSkillManifestEntry {
  readonly name: "nodex";
  readonly path: "skills/nodex";
  readonly treeSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface OfficialAgentSkillsManifest {
  readonly schemaVersion: 1;
  readonly distribution: "NodexApp/skills";
  readonly product: {
    readonly name: "Nodex";
    readonly releaseVersion: string;
  };
  readonly source: {
    readonly repository: string;
    readonly ref: string;
  };
  readonly agentInterface: {
    readonly minimumRevision: 1;
    readonly maximumRevision: 1;
  };
  readonly skills: readonly [OfficialSkillManifestEntry];
}

interface ResolvedOptions {
  readonly repositoryRoot: string;
  readonly outputDirectory: string;
  readonly sourceRepository: string;
  readonly sourceRef: string | null;
}

interface ValidatedTree {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly totalBytes: number;
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function requireBoundedIdentity(value: string, label: string, pattern: RegExp): string {
  if (value.length === 0 || value.length > 256 || value.trim() !== value || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function resolveOptions(options: OfficialAgentSkillsOptions = {}): ResolvedOptions {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const outputDirectory = resolve(
    options.outputDirectory ?? join(repositoryRoot, DEFAULT_OUTPUT_RELATIVE),
  );
  const sourceRepository = requireBoundedIdentity(
    options.sourceRepository ??
      process.env.NODEX_AGENT_SKILLS_SOURCE_REPOSITORY ??
      process.env.GITHUB_REPOSITORY ??
      "local/nodex",
    "Skill source repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  const configuredRef = options.sourceRef ?? process.env.NODEX_AGENT_SKILLS_SOURCE_REF ?? null;
  const sourceRef =
    configuredRef === null
      ? null
      : requireBoundedIdentity(configuredRef, "Skill source ref", /^[A-Za-z0-9._/-]+$/);

  const generatedBoundary = resolve(repositoryRoot, GENERATED_ROOT);
  const relativeOutput = relative(generatedBoundary, outputDirectory);
  if (
    relativeOutput.length === 0 ||
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${sep}`)
  ) {
    throw new Error("Official Skill output must stay inside .generated");
  }

  return {
    repositoryRoot,
    outputDirectory,
    sourceRepository,
    sourceRef,
  };
}

function allowedDirectories(paths: readonly string[]): ReadonlySet<string> {
  const directories = new Set<string>([""]);
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

async function validateExactTree(
  root: string,
  allowedFiles: readonly string[],
  totalByteLimit: number,
): Promise<ValidatedTree> {
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${root}`);
  }

  const fileAllowlist = new Set(allowedFiles);
  const directoryAllowlist = allowedDirectories(allowedFiles);
  const files = new Map<string, Buffer>();

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = portablePath(relative(root, absolutePath));
      if (
        relativePath.length === 0 ||
        relativePath.startsWith("../") ||
        relativePath.includes("/../")
      ) {
        throw new Error(`Unsafe Skill path: ${relativePath}`);
      }

      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Skill tree contains a symlink: ${relativePath}`);
      }
      if (entryStat.isDirectory()) {
        if (!directoryAllowlist.has(relativePath)) {
          throw new Error(`Skill tree contains an unknown directory: ${relativePath}`);
        }
        await visit(absolutePath);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new Error(`Skill tree contains a special file: ${relativePath}`);
      }
      if (!fileAllowlist.has(relativePath)) {
        throw new Error(`Skill tree contains an unknown file: ${relativePath}`);
      }
      if (entryStat.nlink !== 1) {
        throw new Error(`Skill tree contains a hard-linked file: ${relativePath}`);
      }
      if (entryStat.size > MAX_FILE_BYTES) {
        throw new Error(`Skill file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
      }

      const contents = await readFile(absolutePath);
      if (contents.includes(Buffer.from("\r\n"))) {
        throw new Error(`Skill file uses CRLF line endings: ${relativePath}`);
      }
      files.set(relativePath, contents);
    }
  }

  await visit(root);

  const missing = allowedFiles.filter((path) => !files.has(path));
  if (missing.length > 0) {
    throw new Error(`Skill tree is missing required files: ${missing.join(", ")}`);
  }
  const totalBytes = [...files.values()].reduce(
    (total, contents) => total + contents.byteLength,
    0,
  );
  if (totalBytes > totalByteLimit) {
    throw new Error(`Skill tree exceeds ${totalByteLimit} bytes`);
  }

  return { files, totalBytes };
}

function decodeUtf8(contents: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function validateSkillMetadata(files: ReadonlyMap<string, Buffer>): void {
  const skill = decodeUtf8(files.get("SKILL.md") ?? Buffer.alloc(0), "SKILL.md");
  const lines = skill.split("\n");
  if (lines.length > MAX_SKILL_LINES) {
    throw new Error(`SKILL.md exceeds ${MAX_SKILL_LINES} lines`);
  }
  if (lines[0] !== "---") {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const frontmatterEnd = lines.indexOf("---", 1);
  if (frontmatterEnd < 2) {
    throw new Error("SKILL.md frontmatter is incomplete");
  }
  const frontmatterKeys = lines
    .slice(1, frontmatterEnd)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(":", 1)[0]?.trim());
  if (
    frontmatterKeys.length !== 2 ||
    frontmatterKeys[0] !== "name" ||
    frontmatterKeys[1] !== "description"
  ) {
    throw new Error("SKILL.md frontmatter may contain only name and description");
  }
  if (!lines[1]?.match(/^name:\s+nodex$/)) {
    throw new Error("Official Skill frontmatter name must be nodex");
  }
  if (!lines[2]?.match(/^description:\s+\S/)) {
    throw new Error("Official Skill requires a non-empty description");
  }

  const openai = decodeUtf8(
    files.get("agents/openai.yaml") ?? Buffer.alloc(0),
    "agents/openai.yaml",
  );
  if (!openai.includes('display_name: "Nodex"')) {
    throw new Error("OpenAI metadata display name must be Nodex");
  }
  if (!openai.match(/short_description:\s+"[^"]{25,64}"/)) {
    throw new Error("OpenAI short description must contain 25–64 characters");
  }
  if (!openai.match(/default_prompt:\s+"[^"]*\$nodex[^"]*"/)) {
    throw new Error("OpenAI default prompt must mention $nodex");
  }
  if (/^(dependencies|policy):/m.test(openai)) {
    throw new Error("Official Skill metadata must not declare dependencies or policy");
  }
}

export function renderNestedMarkdownReference(): string {
  for (const example of NESTED_MARKDOWN_AGENT_GUIDE.examples) {
    const roundTrip = serializeNfm(parseNfm(example));
    if (roundTrip !== example) {
      throw new Error("Production Nested Markdown example failed round-trip");
    }
  }

  const examples = NESTED_MARKDOWN_AGENT_GUIDE.examples
    .map((example) => `\`\`\`nested-markdown\n${example}\n\`\`\``)
    .join("\n\n");

  return [
    "# Nested Markdown",
    "",
    "This reference is generated from Nodex's production Agent guide. Specification",
    `revision: \`${NESTED_MARKDOWN_AGENT_GUIDE.specificationVersion}\`.`,
    "",
    "## Authoring rules",
    "",
    NESTED_MARKDOWN_AGENT_GUIDE.instructions,
    "",
    "For the CLI, translate dynamic-tool wording to the equivalent native workflow:",
    "use `nodex read` before identity-sensitive edits and use semantic `nodex page`",
    "or `nodex block` commands for owning Pages. Write complete bodies through a",
    "file so literal tabs and user text are preserved exactly.",
    "",
    "## Round-trip examples",
    "",
    examples,
    "",
    "Each example is parsed and serialized by the production Nested Markdown codec",
    "during artifact generation. A mismatch fails generation.",
    "",
  ].join("\n");
}

function hashSkillTree(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    const contents = files.get(path);
    if (!contents) {
      throw new Error(`Missing Skill file while hashing: ${path}`);
    }
    hash.update(path, "utf8");
    hash.update("\0");
    hash.update(String(contents.byteLength), "utf8");
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function officialSkillTreeSha256(files: ReadonlyMap<string, Buffer>): string {
  return hashSkillTree(files);
}

function renderReadme(version: string): string {
  return [
    "# Official Nodex Agent Skills",
    "",
    "This repository is a release-generated mirror of the official Nodex Agent Skill.",
    "Source changes belong in the Nodex product repository.",
    "",
    "Install the latest public copy:",
    "",
    "```sh",
    "npx skills@latest add NodexApp/skills",
    "```",
    "",
    "Install this exact release:",
    "",
    "```sh",
    `npx skills@latest add https://github.com/NodexApp/skills/tree/v${version}`,
    "```",
    "",
    `This artifact matches Nodex ${version}. The Skill requires the local Nodex CLI`,
    "and Core; it does not provide remote access to a user's local Nodex data.",
    "",
  ].join("\n");
}

async function buildExpectedArtifact(options: ResolvedOptions): Promise<{
  readonly files: ReadonlyMap<string, Buffer>;
  readonly manifest: OfficialAgentSkillsManifest;
}> {
  const authoringRoot = join(options.repositoryRoot, AUTHORING_SKILL_RELATIVE);
  const sourceTree = await validateExactTree(authoringRoot, OFFICIAL_SKILL_FILES, MAX_SKILL_BYTES);
  validateSkillMetadata(sourceTree.files);

  const nestedMarkdown = decodeUtf8(
    sourceTree.files.get("references/nested-markdown.md") ?? Buffer.alloc(0),
    "references/nested-markdown.md",
  );
  if (nestedMarkdown !== renderNestedMarkdownReference()) {
    throw new Error(
      "references/nested-markdown.md is stale; regenerate it from the production guide",
    );
  }

  const packageManifest = JSON.parse(
    await readFile(join(options.repositoryRoot, "package.json"), "utf8"),
  ) as PackageManifest;
  const version = packageManifest.version;
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("package.json must provide a valid release version");
  }
  const sourceRef = options.sourceRef ?? `v${version}`;

  const skillEntry: OfficialSkillManifestEntry = {
    name: "nodex",
    path: "skills/nodex",
    treeSha256: hashSkillTree(sourceTree.files),
    fileCount: sourceTree.files.size,
    totalBytes: sourceTree.totalBytes,
  };
  const manifest: OfficialAgentSkillsManifest = {
    schemaVersion: 1,
    distribution: "NodexApp/skills",
    product: {
      name: "Nodex",
      releaseVersion: version,
    },
    source: {
      repository: options.sourceRepository,
      ref: sourceRef,
    },
    agentInterface: {
      minimumRevision: 1,
      maximumRevision: 1,
    },
    skills: [skillEntry],
  };

  const outputFiles = new Map<string, Buffer>();
  for (const [path, contents] of sourceTree.files) {
    outputFiles.set(`${SKILL_OUTPUT_PREFIX}/${path}`, contents);
  }
  outputFiles.set("README.md", Buffer.from(renderReadme(version), "utf8"));
  outputFiles.set("LICENSE", await readFile(join(options.repositoryRoot, "LICENSE")));
  outputFiles.set(
    "release-manifest.json",
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );

  return { files: outputFiles, manifest };
}

async function writeArtifact(
  outputDirectory: string,
  files: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const generatedRoot = resolve(outputDirectory, "..");
  await mkdir(generatedRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(generatedRoot, ".official-agent-skills-"));
  try {
    for (const [path, contents] of files) {
      const destination = join(temporaryDirectory, ...path.split("/"));
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, contents, { flag: "wx", mode: 0o644 });
    }
    await rm(outputDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, outputDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function outputAllowlist(): string[] {
  return [
    ...OUTPUT_TOP_LEVEL_FILES,
    ...OFFICIAL_SKILL_FILES.map((path) => `${SKILL_OUTPUT_PREFIX}/${path}`),
  ];
}

export async function generateOfficialAgentSkills(
  requestedOptions: OfficialAgentSkillsOptions = {},
): Promise<OfficialAgentSkillsManifest> {
  const options = resolveOptions(requestedOptions);
  const expected = await buildExpectedArtifact(options);
  await writeArtifact(options.outputDirectory, expected.files);
  await verifyResolvedArtifact(options);
  return expected.manifest;
}

async function verifyResolvedArtifact(
  options: ResolvedOptions,
): Promise<OfficialAgentSkillsManifest> {
  const expected = await buildExpectedArtifact(options);
  const actual = await validateExactTree(
    options.outputDirectory,
    outputAllowlist(),
    MAX_SKILL_BYTES + 256 * 1024,
  );

  for (const [path, expectedContents] of expected.files) {
    const actualContents = actual.files.get(path);
    if (!actualContents?.equals(expectedContents)) {
      throw new Error(`Generated official Skill artifact is stale: ${path}`);
    }
  }
  return expected.manifest;
}

export async function verifyOfficialAgentSkills(
  requestedOptions: OfficialAgentSkillsOptions = {},
): Promise<OfficialAgentSkillsManifest> {
  return await verifyResolvedArtifact(resolveOptions(requestedOptions));
}

function localBinary(repositoryRoot: string, name: string): string {
  return join(
    repositoryRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export async function smokeOfficialAgentSkills(
  requestedOptions: OfficialAgentSkillsOptions = {},
): Promise<OfficialAgentSkillsManifest> {
  const options = resolveOptions(requestedOptions);
  const manifest = await verifyResolvedArtifact(options);
  const skillDirectory = join(options.outputDirectory, "skills", "nodex");

  await execFileAsync(
    localBinary(options.repositoryRoot, "skills-ref"),
    ["validate", skillDirectory],
    {
      cwd: options.repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const { stdout } = await execFileAsync(
    localBinary(options.repositoryRoot, "skills"),
    ["add", options.outputDirectory, "--list"],
    {
      cwd: options.repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const skillMatches = stripAnsi(stdout).match(/^\s*│?\s*nodex\s*$/gmu) ?? [];
  if (skillMatches.length !== 1) {
    throw new Error(
      `Public artifact discovery must find exactly one nodex Skill:\n${stripAnsi(stdout)}`,
    );
  }

  return manifest;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const manifest =
    command === "generate"
      ? await generateOfficialAgentSkills()
      : command === "verify"
        ? await verifyOfficialAgentSkills()
        : command === "smoke"
          ? await smokeOfficialAgentSkills()
          : null;
  if (!manifest) {
    throw new Error("Usage: tsx scripts/official-agent-skills.ts <generate|verify|smoke>");
  }
  process.stdout.write(
    `Official Nodex Skill ${command} passed (${manifest.skills[0].treeSha256}).\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
