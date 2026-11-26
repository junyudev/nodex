import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  readUnreleasedChangesWithMedia,
  type UnreleasedChange,
} from "../../src/shared/change-media";
import { groupChangeEntries, parseReleaseNotes } from "../../src/shared/changelog";
import { readMediaFile, resolveMediaStore } from "../media/store";
import { formatReleaseCard, type CardMediaFile } from "./card-markdown";
import { readChangeFilesAtRef } from "./changelog";
import { normalizeStableVersion } from "./model";

const defaultProject = "growth";
const defaultParent = "data_source:5f3bedb5-099b-7cfd-8ebc-f30f5e7bb153";
const usage = `Usage: vp run release:card -- <version> [--dry-run] [--replace] [--project ${defaultProject}] [--parent ${defaultParent}]`;

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  input?: string | Buffer,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function readTaggedChanges(cwd: string, tag: string, dryRun: boolean): readonly UnreleasedChange[] {
  const ref = `refs/tags/${tag}`;
  if (run("git", ["tag", "--list", tag], cwd) === tag) {
    return readUnreleasedChangesWithMedia(readChangeFilesAtRef(cwd, ref));
  }
  if (!dryRun) {
    run("git", ["fetch", "--no-tags", "--no-write-fetch-head", "origin", "tag", tag], cwd);
    return readUnreleasedChangesWithMedia(readChangeFilesAtRef(cwd, ref));
  }
  // A preview of a remote tag must leave the current repository's refs and objects alone.
  const remote = run("git", ["remote", "get-url", "origin"], cwd);
  const temporary = mkdtempSync(join(tmpdir(), "nodex-release-card-"));
  try {
    run("git", ["init", "--bare", "--quiet"], temporary);
    run(
      "git",
      ["--git-dir", temporary, "fetch", "--no-tags", "--depth=1", "--", remote, "tag", tag],
      cwd,
    );
    return readUnreleasedChangesWithMedia(readChangeFilesAtRef(temporary, ref));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function readCardMedia(
  cwd: string,
  changes: readonly UnreleasedChange[],
  importFile?: (name: string, bytes: Buffer) => string,
): ReadonlyMap<string, CardMediaFile> {
  const names = new Set(
    changes
      .flatMap(({ media }) => media.flatMap(({ light, dark }) => [light, dark]))
      .filter((name) => name !== undefined),
  );
  const files = new Map<string, CardMediaFile>();
  if (names.size === 0) return files;
  const store = resolveMediaStore(cwd);
  for (const name of names) {
    const path = join(store, name);
    const missing = !lstatSync(path, { throwIfNoEntry: false })?.isFile();
    if (!importFile) {
      files.set(name, { url: `nodex://files/placeholder-${name}`, missing });
      continue;
    }
    if (missing) {
      files.set(name, { url: null, missing });
      continue;
    }
    const file = readMediaFile(path);
    if (file.name !== name) throw new Error(`${path} does not match its SHA-256 filename.`);
    files.set(name, { url: `nodex://files/${importFile(name, file.data)}`, missing });
  }
  return files;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      replace: { type: "boolean", default: false },
      project: { type: "string", default: defaultProject },
      parent: { type: "string", default: defaultParent },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (positionals.length !== 1) throw new Error(usage);
  const version = normalizeStableVersion(positionals[0]!);
  const tag = `v${version}`;
  const title = `${tag} 更新帖`;
  const sourceId = /^data_source:@?([^@].*)$/u.exec(values.parent)?.[1];
  if (!sourceId) throw new Error("--parent must name a board's Data Source as data_source:<id>.");

  const cwd = process.cwd();
  const changes = readTaggedChanges(cwd, tag, values["dry-run"]);
  const { body, url: releaseUrl } = JSON.parse(
    run("gh", ["release", "view", tag, "--json", "body,url"], cwd),
  ) as { body: string; url: string };
  const { headline, sections } = parseReleaseNotes(body, `GitHub release ${tag}`);
  if (!isDeepStrictEqual(sections, groupChangeEntries(changes))) {
    throw new Error(`GitHub release ${tag} sections differ from change files at refs/tags/${tag}.`);
  }
  if (values["dry-run"]) {
    const files = readCardMedia(cwd, changes);
    process.stdout.write(formatReleaseCard({ version, headline, releaseUrl, changes, files }));
    return;
  }

  function nodex<T>(args: readonly string[], input?: string | Buffer): T {
    const stdout = run("nodex", ["--json", "--project", values.project, ...args], cwd, input);
    return (JSON.parse(stdout) as { result: T }).result;
  }
  const { rows } = nodex<{ rows: [pageId: string][] }>([
    "sql",
    "query",
    "--bind",
    `release_cards=${sourceId}`,
    "SELECT page_id FROM release_cards WHERE title = :title",
    "--param",
    `title=${JSON.stringify(title)}`,
  ]);
  if (rows.length > 1) {
    const urls = rows.map(([id]) => `nodex://pages/${id}`);
    throw new Error(`Multiple Pages titled "${title}" in ${values.parent}:\n${urls.join("\n")}`);
  }
  const existing = rows[0]?.[0];
  if (existing && !values.replace) {
    process.stdout.write(`nodex://pages/${existing}\n`);
    return;
  }
  const bodyETag = existing
    ? nodex<{ validators: { body_etag: string } }>(["read", existing]).validators.body_etag
    : "";
  if (existing && !bodyETag) throw new Error(`Page ${existing} has no body ETag.`);
  const files = readCardMedia(cwd, changes, (name, bytes) => {
    const receipt = nodex<{ file_mutation: { file_id: string } }>(
      [
        "file",
        "import",
        "--from",
        "-",
        "--name",
        name,
        "--mime",
        name.endsWith(".png") ? "image/png" : "video/mp4",
        "--idempotency-key",
        `release-card-media-${name}`,
      ],
      bytes,
    );
    return receipt.file_mutation.file_id;
  });
  const markdown = formatReleaseCard({ version, headline, releaseUrl, changes, files });
  const write = existing
    ? ["page", "replace", existing, "--if-match", bodyETag, "--file", "-"]
    : [
        "page",
        "create",
        "--parent",
        values.parent,
        "--title",
        title,
        "--set",
        "Status=plan",
        "--file",
        "-",
      ];
  const { url } = nodex<{ url: string }>(write, markdown);
  process.stdout.write(`${url}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
