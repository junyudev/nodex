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
import { CHANGES_README } from "../../src/shared/changelog";
import { readMediaFile, resolveMediaStore, storeMediaFile } from "./store";

export async function addChangeMedia(
  cwd: string,
  changeFile: string,
  options: ChangeMediaItem,
): Promise<{ readonly paths: readonly string[]; readonly item: ChangeMediaItem }> {
  const changePath = resolve(cwd, changeFile);
  const path = relative(cwd, changePath).split(sep).join("/");
  const stats = lstatSync(changePath);
  if (!stats.isFile() || realpathSync(changePath) !== join(realpathSync(cwd), path)) {
    throw new Error(`${path} must be a regular change file. See ${CHANGES_README}.`);
  }
  const original = readFileSync(changePath);
  if (!isUtf8(original)) throw new Error(`${path} must be a UTF-8 file. See ${CHANGES_README}.`);

  const light =
    options.light === undefined ? undefined : readMediaFile(resolve(cwd, options.light));
  const dark = options.dark === undefined ? undefined : readMediaFile(resolve(cwd, options.dark));
  const item: ChangeMediaItem = {
    caption: options.caption,
    ...(light && { light: light.name }),
    ...(dark && { dark: dark.name }),
  };
  const { media, body } = upsertChangeMedia({ path, content: original.toString("utf8") }, item);
  // Match Oxfmt's YAML formatting while preserving the original Markdown bytes.
  const header = await format(stringify({ media }, { lineWidth: 0 }), { parser: "yaml" });
  const separator = /^(?:\r\n?|\n)/u.test(body) ? "" : "\n";
  const updated = `---\n${header}---\n${separator}${body}`;

  const store = resolveMediaStore(cwd);
  const paths = [light, dark].flatMap((media) => (media ? [storeMediaFile(store, media)] : []));
  const staging = mkdtempSync(join(cwd, ".media-add-"));
  try {
    const temporary = join(staging, "change.md");
    writeFileSync(temporary, updated, { mode: stats.mode });
    if (!readFileSync(changePath).equals(original)) {
      throw new Error(
        `${path} changed while its media was being added. Run vp run media:add again.`,
      );
    }
    renameSync(temporary, changePath);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { paths, item };
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
    },
  });
  const [file] = positionals;
  if (
    positionals.length !== 1 ||
    !file ||
    values.caption === undefined ||
    !(values.light || values.dark)
  ) {
    throw new Error(
      'Usage: vp run media:add -- <change-file> --caption "<text>" [--light <file>] [--dark <file>].',
    );
  }
  const { paths, item } = await addChangeMedia(process.cwd(), file, {
    ...values,
    caption: values.caption,
  });
  process.stdout.write(`${paths.join("\n")}\n${JSON.stringify(item, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
