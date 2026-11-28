import { isUtf8 } from "node:buffer";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { format } from "prettier";
import { stringify } from "yaml";
import { upsertChangeMedia, type ChangeMediaItem } from "../../src/shared/change-media";
import { CHANGES_README, parseChangelog, RELEASE_MEDIA_PATH } from "../../src/shared/changelog";
import {
  parseReleaseMedia,
  upsertReleaseMedia,
  validateReleaseMediaTargets,
} from "../release/release-media";
import { readMediaFile, resolveMediaStore, storeMediaFile } from "./store";

async function addMedia(
  cwd: string,
  file: string,
  options: ChangeMediaItem,
  update: (file: { path: string; content: string }, item: ChangeMediaItem) => Promise<string>,
): Promise<{ readonly paths: readonly string[]; readonly item: ChangeMediaItem }> {
  const target = resolve(cwd, file);
  const path = relative(cwd, target).split(sep).join("/");
  const stats = lstatSync(target);
  if (!stats.isFile() || realpathSync(target) !== join(realpathSync(cwd), path)) {
    throw new Error(`${path} must be a regular file within the worktree. See ${CHANGES_README}.`);
  }
  const original = readFileSync(target);
  if (!isUtf8(original)) throw new Error(`${path} must be a UTF-8 file. See ${CHANGES_README}.`);

  const light =
    options.light === undefined ? undefined : readMediaFile(resolve(cwd, options.light));
  const dark = options.dark === undefined ? undefined : readMediaFile(resolve(cwd, options.dark));
  const item: ChangeMediaItem = {
    caption: options.caption,
    ...(light && { light: light.name }),
    ...(dark && { dark: dark.name }),
  };
  const updated = await update({ path, content: original.toString("utf8") }, item);

  const store = resolveMediaStore(cwd);
  const paths = [light, dark].flatMap((media) => (media ? [storeMediaFile(store, media)] : []));
  const staging = mkdtempSync(join(cwd, ".media-add-"));
  try {
    const temporary = join(staging, "entry");
    writeFileSync(temporary, updated, { mode: stats.mode });
    if (!readFileSync(target).equals(original)) {
      throw new Error(
        `${path} changed while its media was being added. Run vp run media:add again.`,
      );
    }
    renameSync(temporary, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { paths, item };
}

export function addChangeMedia(cwd: string, changeFile: string, options: ChangeMediaItem) {
  return addMedia(cwd, changeFile, options, async (file, item) => {
    const { media, body } = upsertChangeMedia(file, item);
    // Match Oxfmt's YAML formatting while preserving the original Markdown bytes.
    const header = await format(stringify({ media }, { lineWidth: 0 }), { parser: "yaml" });
    const separator = /^(?:\r\n?|\n)/u.test(body) ? "" : "\n";
    return `---\n${header}---\n${separator}${body}`;
  });
}

export function addReleaseMedia(
  cwd: string,
  version: string,
  slug: string,
  options: ChangeMediaItem,
) {
  return addMedia(cwd, RELEASE_MEDIA_PATH, options, ({ content }, item) => {
    const updated = upsertReleaseMedia(content, version, slug, item);
    const releases = parseChangelog(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"));
    validateReleaseMediaTargets(cwd, parseReleaseMedia(updated), releases);
    return format(updated, { parser: "yaml" });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      caption: { type: "string" },
      light: { type: "string" },
      dark: { type: "string" },
      release: { type: "string" },
    },
  });
  const [file] = positionals;
  if (
    positionals.length !== 1 ||
    !file ||
    values.release === "" ||
    values.caption === undefined ||
    !(values.light || values.dark)
  ) {
    throw new Error(
      'Usage: vp run media:add -- <change-file> | --release <version> <slug>, with --caption "<text>" [--light <file>] [--dark <file>].',
    );
  }
  const options = {
    caption: values.caption,
    light: values.light,
    dark: values.dark,
  };
  const cwd = process.cwd();
  const { paths, item } = await (values.release === undefined
    ? addChangeMedia(cwd, file, options)
    : addReleaseMedia(cwd, values.release, file, options));
  process.stdout.write(`${paths.join("\n")}\n${JSON.stringify(item, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
