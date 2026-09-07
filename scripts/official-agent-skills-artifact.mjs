import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 768 * 1024;
const SKILL_PREFIX = "skills/nodex";

export const OFFICIAL_AGENT_SKILL_FILES = Object.freeze([
  "SKILL.md",
  "agents/openai.yaml",
  "references/nested-markdown.md",
  "references/page-editor.md",
  "references/project-database-views.md",
  "references/queries-and-configuration.md",
  "references/troubleshooting.md",
]);

export const OFFICIAL_AGENT_SKILLS_ARTIFACT_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "release-manifest.json",
  ...OFFICIAL_AGENT_SKILL_FILES.map((entry) => `${SKILL_PREFIX}/${entry}`),
]);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (value, expected, label) => {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has an unsupported shape`);
  }
};

const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

const requireSha256 = (value, label) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
};

const sha256Bytes = (value) => createHash("sha256").update(value).digest("hex");

const allowedDirectories = () => {
  const directories = new Set([""]);
  for (const file of OFFICIAL_AGENT_SKILLS_ARTIFACT_FILES) {
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
};

const portableRelativePath = (root, entryPath) =>
  path.relative(root, entryPath).split(path.sep).join("/");

const readExactArtifactTree = (root) => {
  const resolvedRoot = path.resolve(root);
  const rootMetadata = lstatSync(resolvedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Official Agent Skills artifact must be a real directory: ${resolvedRoot}`);
  }

  const allowedFiles = new Set(OFFICIAL_AGENT_SKILLS_ARTIFACT_FILES);
  const directories = allowedDirectories();
  const files = new Map();
  let totalBytes = 0;

  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = portableRelativePath(resolvedRoot, entryPath);
      if (
        relativePath.length === 0 ||
        relativePath.startsWith("../") ||
        relativePath.includes("/../")
      ) {
        throw new Error(`Official Agent Skills artifact contains an unsafe path: ${relativePath}`);
      }
      const metadata = lstatSync(entryPath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Official Agent Skills artifact contains a symlink: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        if (!directories.has(relativePath)) {
          throw new Error(
            `Official Agent Skills artifact contains an unknown directory: ${relativePath}`,
          );
        }
        visit(entryPath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Official Agent Skills artifact contains a special file: ${relativePath}`);
      }
      if (!allowedFiles.has(relativePath)) {
        throw new Error(`Official Agent Skills artifact contains an unknown file: ${relativePath}`);
      }
      if (metadata.nlink !== 1) {
        throw new Error(
          `Official Agent Skills artifact contains a hard-linked file: ${relativePath}`,
        );
      }
      if (metadata.size > MAX_FILE_BYTES) {
        throw new Error(`Official Agent Skills artifact file is too large: ${relativePath}`);
      }
      const contents = readFileSync(entryPath);
      if (contents.includes(Buffer.from("\r\n"))) {
        throw new Error(`Official Agent Skills artifact uses CRLF line endings: ${relativePath}`);
      }
      new TextDecoder("utf-8", { fatal: true }).decode(contents);
      files.set(relativePath, contents);
      totalBytes += contents.byteLength;
    }
  };

  visit(resolvedRoot);
  const missing = OFFICIAL_AGENT_SKILLS_ARTIFACT_FILES.filter((entry) => !files.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Official Agent Skills artifact is missing required files: ${missing.join(", ")}`,
    );
  }
  if (totalBytes > MAX_ARTIFACT_BYTES) {
    throw new Error("Official Agent Skills artifact exceeds its total byte limit");
  }
  return files;
};

const hashSkillTree = (files) => {
  const hash = createHash("sha256");
  for (const relativePath of [...OFFICIAL_AGENT_SKILL_FILES].sort()) {
    const artifactPath = `${SKILL_PREFIX}/${relativePath}`;
    const contents = files.get(artifactPath);
    if (!contents) throw new Error(`Official Agent Skill file is missing: ${artifactPath}`);
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(String(contents.byteLength), "utf8");
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const parseReleaseManifest = (contents) => {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  } catch (error) {
    throw new Error("Official Agent Skills release manifest is invalid", { cause: error });
  }
  assertExactKeys(
    value,
    ["schemaVersion", "distribution", "product", "source", "agentInterface", "skills"],
    "Official Agent Skills release manifest",
  );
  if (value.schemaVersion !== 1 || value.distribution !== "NodexApp/skills") {
    throw new Error("Official Agent Skills release manifest contract is unsupported");
  }
  assertExactKeys(value.product, ["name", "releaseVersion"], "Skill product");
  if (
    value.product.name !== "Nodex" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(
      requireString(value.product.releaseVersion, "Skill release version"),
    )
  ) {
    throw new Error("Official Agent Skills product metadata is invalid");
  }
  assertExactKeys(value.source, ["repository", "ref"], "Skill source");
  requireString(value.source.repository, "Skill source repository");
  requireString(value.source.ref, "Skill source ref");
  assertExactKeys(
    value.agentInterface,
    ["minimumRevision", "maximumRevision"],
    "Skill Agent interface",
  );
  if (value.agentInterface.minimumRevision !== 1 || value.agentInterface.maximumRevision !== 1) {
    throw new Error("Official Agent Skills Agent interface range is unsupported");
  }
  if (!Array.isArray(value.skills) || value.skills.length !== 1) {
    throw new Error("Official Agent Skills release must contain exactly one Skill");
  }
  const skill = value.skills[0];
  assertExactKeys(
    skill,
    ["name", "path", "treeSha256", "fileCount", "totalBytes"],
    "Official Agent Skill entry",
  );
  if (
    skill.name !== "nodex" ||
    skill.path !== SKILL_PREFIX ||
    skill.fileCount !== OFFICIAL_AGENT_SKILL_FILES.length ||
    !Number.isSafeInteger(skill.totalBytes) ||
    skill.totalBytes <= 0
  ) {
    throw new Error("Official Agent Skill entry is invalid");
  }
  requireSha256(skill.treeSha256, "Official Agent Skill treeSha256");
  return value;
};

export const inspectOfficialAgentSkillsArtifact = (artifactRoot) => {
  const files = readExactArtifactTree(artifactRoot);
  const manifestContents = files.get("release-manifest.json");
  if (!manifestContents) {
    throw new Error("Official Agent Skills release manifest is missing");
  }
  const manifest = parseReleaseManifest(manifestContents);
  const treeSha256 = hashSkillTree(files);
  const skillBytes = OFFICIAL_AGENT_SKILL_FILES.reduce(
    (total, relativePath) =>
      total + (files.get(`${SKILL_PREFIX}/${relativePath}`)?.byteLength ?? 0),
    0,
  );
  if (
    manifest.skills[0].treeSha256 !== treeSha256 ||
    manifest.skills[0].totalBytes !== skillBytes
  ) {
    throw new Error("Official Agent Skill tree does not match its release manifest");
  }
  return {
    manifest,
    manifestSha256: sha256Bytes(manifestContents),
    releaseVersion: manifest.product.releaseVersion,
    sourceRef: manifest.source.ref,
    sourceRepository: manifest.source.repository,
    treeSha256,
  };
};
