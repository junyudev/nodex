import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./filesystem-durability";
import { isMap, isScalar, parseDocument } from "yaml";
import {
  MAX_SKILL_MANIFEST_BYTES,
  SkillSlugSchema,
  type SkillFailure,
} from "../../../shared/skill-inventory";

const maxEntries = 4096;
const maxTreeBytes = 64 * 1024 * 1024;
const maxDepth = 16;

export class SkillFileError extends Error {
  constructor(
    readonly code: SkillFailure["code"],
    message: string,
  ) {
    super(message);
  }
}

export const skillFailure = (cause: unknown): SkillFailure =>
  cause instanceof SkillFileError
    ? { status: "failed", code: cause.code, message: cause.message }
    : { status: "failed", code: "io", message: "The skill operation could not be completed." };

const missing = (cause: unknown) => (cause as NodeJS.ErrnoException)?.code === "ENOENT";
export const statIfPresent = (file: string) =>
  fs.lstat(file).catch((cause: unknown) => {
    if (missing(cause)) return null;
    throw cause;
  });

export function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function skillSlug(slug: string): string {
  if (!SkillSlugSchema.safeParse(slug).success)
    throw new SkillFileError(
      "invalid_input",
      "Use a portable skill name with lowercase letters, digits or hyphens.",
    );
  return slug;
}

export const skillIdentity = (...parts: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("base64url");

/** A configured base may be an alias. Its child path may never redirect to another location. */
export async function canonicalBase(base: string): Promise<string> {
  if (!path.isAbsolute(base))
    throw new SkillFileError("unsafe", "The skill base must be absolute.");
  const normalized = path.resolve(base);
  if (await statIfPresent(normalized)) {
    const real = await fs.realpath(normalized);
    if (!(await fs.stat(real)).isDirectory())
      throw new SkillFileError("unsafe", "The skill base is not a directory.");
    return real;
  }
  return path.join(await canonicalBase(path.dirname(normalized)), path.basename(normalized));
}

export async function checkDirectory(directory: string, create = false): Promise<boolean> {
  let info = await statIfPresent(directory);
  if (!info && !create) return false;
  if (!info) {
    await checkDirectory(path.dirname(directory), true);
    await fs.mkdir(directory).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException)?.code !== "EEXIST") throw cause;
    });
    info = await statIfPresent(directory);
  }
  if (!info?.isDirectory() || (await fs.realpath(directory)) !== directory)
    throw new SkillFileError("unsafe", "The skill directory was redirected.");
  return true;
}

export async function containedRoot(base: string, segments: readonly string[]): Promise<string> {
  let directory = await canonicalBase(base);
  for (const segment of segments) {
    directory = path.join(directory, segment);
    await checkDirectory(directory);
  }
  return directory;
}

export async function canWrite(directory: string): Promise<boolean> {
  try {
    await fs.access(await existingAncestor(directory), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function existingAncestor(directory: string): Promise<string> {
  if (await checkDirectory(directory)) return directory;
  return existingAncestor(path.dirname(directory));
}

export async function scanSkillDirectories(root: string, recursive: boolean): Promise<string[]> {
  if (!(await checkDirectory(root))) return [];
  const pending = [{ directory: root, depth: 0 }];
  const skills: string[] = [];
  let entries = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    const children = await fs.opendir(directory);
    for await (const child of children) {
      if (++entries > maxEntries)
        throw new SkillFileError("io", "This skill location contains too many entries.");
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      const candidate = path.join(directory, child.name);
      if (!(await checkDirectory(candidate))) continue;
      if (await statIfPresent(path.join(candidate, "SKILL.md"))) skills.push(candidate);
      if (recursive && depth < maxDepth) pending.push({ directory: candidate, depth: depth + 1 });
    }
  }
  return skills.toSorted();
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SkillFileError("unsafe", "SKILL.md is not valid UTF-8.");
  }
}

async function readRegular(file: string, limit = MAX_SKILL_MANIFEST_BYTES) {
  const before = await statIfPresent(file);
  if (!before) throw new SkillFileError("unavailable", "The skill file is gone.");
  if (!before.isFile()) throw new SkillFileError("unsafe", "Skill files must be regular files.");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > limit)
      throw new SkillFileError("unsafe", "The skill file changed or exceeds the supported size.");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== info.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs)
      throw new SkillFileError("io", "The skill file changed during the read.");
    const bytes = buffer.subarray(0, bytesRead);
    return {
      bytes,
      mode: info.mode & 0o777,
      revision: skillIdentity(
        file,
        String(info.dev),
        String(info.ino),
        String(info.ctimeMs),
        createHash("sha256").update(bytes).digest("hex"),
      ),
    };
  } finally {
    await handle.close();
  }
}

export async function readManifest(directory: string) {
  if (!(await checkDirectory(directory)))
    throw new SkillFileError("unavailable", "The skill directory is gone.");
  const result = await readRegular(path.join(directory, "SKILL.md"));
  return { ...result, markdown: decode(result.bytes) };
}

function frontmatter(markdown: string) {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu.exec(markdown);
  if (!match || match.index !== 0) return null;
  const yaml = parseDocument(match[1]);
  if (yaml.errors.length || !isMap(yaml.contents)) return null;
  const name = yaml.get("name", true);
  const description = yaml.get("description");
  if (
    !isScalar(name) ||
    typeof name.value !== "string" ||
    !name.value.trim() ||
    typeof description !== "string" ||
    !description.trim()
  )
    return null;
  return {
    name: name.value,
    description,
    range: name.range,
    offset: match[0].indexOf("\n") + 1,
  };
}

export function manifestMetadata(markdown: string, fallback: string) {
  const meta = frontmatter(markdown);
  return meta
    ? { name: meta.name, description: meta.description, parseError: null }
    : {
        name: fallback,
        description: "",
        parseError: "SKILL.md needs valid name and description frontmatter.",
      };
}

export function renameManifest(markdown: string, slug: string): string {
  const meta = frontmatter(markdown);
  if (!meta?.range)
    throw new SkillFileError("invalid_input", "Repair the skill frontmatter before renaming it.");
  const [start, end] = meta.range.map((offset) => offset + meta.offset);
  const original = markdown.slice(start, end);
  // Block and multiline scalars carry whitespace and comments that cannot safely be moved.
  if (/[\r\n]/u.test(original))
    throw new SkillFileError("invalid_input", "Use a single-line name before renaming this skill.");
  const quote = original.startsWith("'") ? "'" : original.startsWith('"') ? '"' : "";
  const replacement = (delimiter: string) =>
    markdown.slice(0, start) + delimiter + skillSlug(slug) + delimiter + markdown.slice(end);
  const patched = replacement(quote);
  return frontmatter(patched)?.name === slug ? patched : replacement('"');
}

export function manifestBytes(markdown: string): Buffer {
  const bytes = Buffer.from(markdown);
  if (bytes.length > MAX_SKILL_MANIFEST_BYTES || decode(bytes) !== markdown)
    throw new SkillFileError(
      "invalid_input",
      "SKILL.md must be valid UTF-8 within the supported size.",
    );
  return bytes;
}

/** Replace in the same directory after the final binding and revision check. */
export async function replaceFile(
  file: string,
  bytes: Buffer,
  mode: number,
  beforePublish: () => Promise<boolean>,
  create = false,
): Promise<boolean> {
  const directory = path.dirname(file);
  if (!(await checkDirectory(directory)))
    throw new SkillFileError("unavailable", "The skill directory is gone.");
  const temporary = path.join(directory, `.nodex-skill-${randomUUID()}`);
  const handle = await fs.open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!(await checkDirectory(directory)) || !(await beforePublish())) return false;
    if (create) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
    return true;
  } finally {
    if (await checkDirectory(directory).catch(() => false)) await fs.rm(temporary, { force: true });
  }
}

interface TreeEntry {
  readonly relative: string;
  readonly directory: boolean;
  readonly mode: number;
}

async function readTree(root: string): Promise<TreeEntry[]> {
  if (!(await checkDirectory(root)))
    throw new SkillFileError("unavailable", "The skill directory is gone.");
  const entries: TreeEntry[] = [];
  const pending = [{ directory: root, depth: 0 }];
  let bytes = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop()!;
    if (depth > maxDepth || !(await checkDirectory(directory)))
      throw new SkillFileError("unsafe", "The skill directory changed or is nested too deeply.");
    const children = await fs.opendir(directory);
    for await (const child of children) {
      const file = path.join(directory, child.name);
      const info = await fs.lstat(file);
      if (!info.isDirectory() && !info.isFile())
        throw new SkillFileError("unsafe", "The skill contains a link or unsupported file.");
      bytes += info.isFile() ? info.size : 0;
      if (bytes > maxTreeBytes || entries.length >= maxEntries)
        throw new SkillFileError("io", "The skill directory exceeds the supported size.");
      entries.push({
        relative: path.relative(root, file),
        directory: info.isDirectory(),
        mode: info.mode & 0o777,
      });
      if (info.isDirectory()) pending.push({ directory: file, depth: depth + 1 });
    }
  }
  return entries;
}

export async function listSkillFiles(directory: string): Promise<string[]> {
  return (await readTree(directory))
    .filter((entry) => !entry.directory)
    .map((entry) => entry.relative.split(path.sep).join("/"))
    .toSorted();
}

export async function copySkillTree(source: string, stage: string, replacement?: Buffer) {
  const entries = await readTree(source);
  const revisions = new Map<string, string>();
  let remaining = maxTreeBytes;
  for (const entry of entries) {
    const input = path.join(source, entry.relative);
    const output = path.join(stage, entry.relative);
    if (!(await checkDirectory(path.dirname(input))))
      throw new SkillFileError("unavailable", "The skill directory changed during copying.");
    if (entry.directory) {
      await fs.mkdir(output);
      continue;
    }
    const file = await readRegular(input, remaining);
    remaining -= file.bytes.length;
    revisions.set(entry.relative, file.revision);
    const handle = await fs.open(output, "wx");
    try {
      await handle.writeFile(
        entry.relative === "SKILL.md" && replacement ? replacement : file.bytes,
      );
      await handle.chmod(file.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const entry of entries.toReversed()) {
    if (entry.directory) await fs.chmod(path.join(stage, entry.relative), entry.mode);
  }
  return async () => {
    const current = await readTree(source);
    if (current.length !== entries.length) return false;
    const byName = new Map(entries.map((entry) => [entry.relative, entry]));
    for (const entry of current) {
      const original = byName.get(entry.relative);
      if (!original || original.mode !== entry.mode || original.directory !== entry.directory)
        return false;
      if (
        !entry.directory &&
        (await readRegular(path.join(source, entry.relative), maxTreeBytes)).revision !==
          revisions.get(entry.relative)
      )
        return false;
    }
    return true;
  };
}

export async function assertAvailableName(root: string, slug: string): Promise<void> {
  const entries = await fs.opendir(root);
  for await (const entry of entries) {
    if (entry.name.toLowerCase() === slug)
      throw new SkillFileError("collision", "A skill directory with that name already exists.");
  }
}

export interface StagedSkill {
  readonly root: string;
  readonly directory: string;
  readonly slug: string;
}

export async function stageSkill(root: string, slug: string): Promise<StagedSkill> {
  skillSlug(slug);
  await checkDirectory(root, true);
  await assertAvailableName(root, slug);
  return { root, directory: await fs.mkdtemp(path.join(root, ".nodex-skill-")), slug };
}

export async function discardSkillStage({ directory }: StagedSkill): Promise<void> {
  if (await checkDirectory(directory).catch(() => false))
    await fs.rm(directory, { recursive: true, force: true });
}

/** Reserve the destination exclusively and publish SKILL.md last so incomplete copies are undiscoverable. */
export async function publishSkill({ root, directory: stage, slug }: StagedSkill): Promise<string> {
  const destination = path.join(root, slug);
  await readManifest(stage);
  if (!(await checkDirectory(root)))
    throw new SkillFileError("unavailable", "The destination is gone.");
  await assertAvailableName(root, slug);
  await fs.mkdir(destination).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException)?.code === "EEXIST")
      throw new SkillFileError("collision", "A skill directory with that name already exists.");
    throw cause;
  });
  const reserved = await fs.lstat(destination);
  try {
    const names = await fs.readdir(stage);
    for (const name of names.filter((name) => name !== "SKILL.md")) {
      await checkDirectory(destination);
      await fs.rename(path.join(stage, name), path.join(destination, name));
    }
    await checkDirectory(destination);
    await fs.link(path.join(stage, "SKILL.md"), path.join(destination, "SKILL.md"));
    await syncDirectory(destination);
    await syncDirectory(root);
  } catch (cause) {
    const current = await statIfPresent(destination);
    if (
      current?.ino === reserved.ino &&
      current.dev === reserved.dev &&
      (await checkDirectory(destination))
    )
      await fs.rm(destination, { recursive: true });
    throw cause;
  }
  return destination;
}

export async function writeClaudeSkillOverride(
  file: string,
  name: string,
  enabled: boolean,
  expectedOverride: string | undefined,
): Promise<void> {
  const current = (await statIfPresent(file)) ? await readRegular(file) : null;
  const parsed: unknown = current ? JSON.parse(decode(current.bytes).replace(/^\uFEFF/u, "")) : {};
  if (!isRecord(parsed) || ("skillOverrides" in parsed && !isRecord(parsed.skillOverrides)))
    throw new SkillFileError(
      "invalid_input",
      "Repair the Claude settings file before changing skills.",
    );
  const overrides = isRecord(parsed.skillOverrides) ? { ...parsed.skillOverrides } : {};
  if (
    Object.hasOwn(overrides, name)
      ? overrides[name] !== expectedOverride
      : expectedOverride !== undefined
  )
    throw new SkillFileError(
      "unavailable",
      "Claude settings changed. Refresh before trying again.",
    );
  if (enabled) {
    if (expectedOverride !== "off") return;
    delete overrides[name];
  } else {
    Object.defineProperty(overrides, name, {
      value: "off",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const bytes = manifestBytes(
    `${JSON.stringify({ ...parsed, skillOverrides: overrides }, null, 2)}\n`,
  );
  await checkDirectory(path.dirname(file), true);
  const saved = await replaceFile(
    file,
    bytes,
    current?.mode ?? 0o600,
    async () => {
      if (!current) return !(await statIfPresent(file));
      return (await readRegular(file)).revision === current.revision;
    },
    !current,
  );
  if (!saved)
    throw new SkillFileError("io", "Claude settings changed. Refresh before trying again.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function renameSkillDirectory(directory: string, slug: string, baseRevision: string) {
  const root = path.dirname(directory);
  const destination = path.join(root, skillSlug(slug));
  if (!(await checkDirectory(directory)))
    throw new SkillFileError("unavailable", "The skill directory is gone.");
  const original = await readManifest(directory);
  if (original.revision !== baseRevision) return null;
  if (destination === directory) return directory;
  await assertAvailableName(root, slug);
  const file = path.join(directory, "SKILL.md");
  const bytes = manifestBytes(renameManifest(original.markdown, slug));
  const saved = await replaceFile(
    file,
    bytes,
    original.mode,
    async () => (await readManifest(directory)).revision === baseRevision,
  );
  if (!saved) return null;
  const patched = await readManifest(directory);
  try {
    // Windows directory renames already reject existing destinations. POSIX can
    // replace an empty directory, so reserve that name ourselves first.
    if (process.platform === "win32") {
      await fs.rename(directory, destination);
    } else {
      await fs.mkdir(destination);
      try {
        await fs.rename(directory, destination);
      } catch (cause) {
        await fs.rmdir(destination);
        throw cause;
      }
    }
  } catch (cause) {
    const restored = await replaceFile(
      file,
      original.bytes,
      original.mode,
      async () => (await readManifest(directory)).revision === patched.revision,
    );
    if (!restored)
      throw new SkillFileError("io", "The rename failed and SKILL.md changed on disk.");
    if ((cause as NodeJS.ErrnoException)?.code === "EEXIST")
      throw new SkillFileError("collision", "A skill directory with that name already exists.");
    throw cause;
  }
  return destination;
}

export function blankSkill(stage: string, slug: string) {
  return fs.writeFile(
    path.join(stage, "SKILL.md"),
    `---\nname: "${skillSlug(slug)}"\ndescription: Describe when to use this skill.\n---\n`,
    { flag: "wx" },
  );
}
