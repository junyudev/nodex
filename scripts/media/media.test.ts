import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { readUnreleasedChangesWithMedia } from "../../src/shared/change-media";
import { formatChangelog, RELEASE_MEDIA_PATH } from "../../src/shared/changelog";
import { readReleaseMedia, releaseMediaAttachments } from "../release/release-media";
import { addChangeMedia, addReleaseMedia } from "./add";
import { describeMedia, imageVariantWidths } from "./encode";
import { orphanedMedia, referencedMedia, storedMedia } from "./prune";
import { mediaFilesAtRef } from "./publish";
import { checkLocalChangeMedia, readMediaFile, storeMediaFile } from "./store";

let fixture: string;
let store: string;
const path = "changes/added/2026-11-26-example.md";
const body = "An entry with **detail**.  \r\n  Wrapped line.\r\n\r\n";
const png = Buffer.from("89504e470d0a1a0a", "hex");
const mp4 = Buffer.from("000000146674797069736f6d0000000069736f6d", "hex");
const name = (digit: string, extension = "png") => `${digit.repeat(64)}.${extension}`;
const backfill = (media: string) =>
  `"0.2.0":\n  example:\n    - caption: A picture\n      light: ${media}\n`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "ignore" },
  );

function writeBackfill(cwd: string, content: string) {
  const target = join(cwd, RELEASE_MEDIA_PATH);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

test("keeps full image width and adds a half-width variant at the capture threshold", () => {
  expect(imageVariantWidths(1199)).toEqual([1199]);
  expect(imageVariantWidths(1200)).toEqual([1200, 600]);
  expect(imageVariantWidths(1201)).toEqual([1201, 600]);
});

test("describes the original with widest-first image variants or a video poster", () => {
  const hash = "a".repeat(64);
  const original = { width: 1200, height: 640, bytes: 100 };
  const full = { file: `${hash}.1200w.webp`, width: 1200, height: 640 };
  const half = { file: `${hash}.600w.webp`, width: 600, height: 320 };
  expect(describeMedia(`${hash}.png`, original, { variants: [half, full] })).toEqual({
    version: 1,
    type: "image",
    ...original,
    variants: [full, half],
  });

  const poster = { file: `${hash}.poster.webp`, width: 1200, height: 640 };
  expect(describeMedia(`${hash}.mp4`, original, { poster })).toEqual({
    version: 1,
    type: "video",
    ...original,
    variants: [],
    poster,
  });
});

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "nodex-release-media-"));
  store = join(fixture, "store");
  vi.stubEnv("NODEX_MEDIA_STORE", store);
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), body);
  writeFileSync(join(fixture, "light.png"), png);
  writeFileSync(join(fixture, "dark.mp4"), mp4);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

test("adds or reshoots media while preserving raw entry bytes and other items", async () => {
  const caption = `Review: "Ready" or 'Draft'`;
  const { name: light } = readMediaFile(join(fixture, "light.png"));
  const lightPath = join(store, light);
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      join(import.meta.dirname, "add.ts"),
      "--",
      path,
      "--caption",
      caption,
      "--light",
      "light.png",
    ],
    { cwd: fixture, encoding: "utf8" },
  );
  expect(output).toContain(lightPath);
  expect(readFileSync(lightPath)).toEqual(png);
  const addedChange = readFileSync(join(fixture, path), "utf8");
  expect(addedChange).toBe(
    `---\nmedia:\n  - caption: 'Review: "Ready" or ''Draft'''\n    light: ${light}\n---\n\n${body}`,
  );

  const other = await addChangeMedia(fixture, path, {
    caption: "Watch the dark view",
    dark: "dark.mp4",
  });
  expect(readFileSync(other.paths[0]!)).toEqual(mp4);

  const replacement = Buffer.concat([png, Buffer.from("Reshoot")]);
  writeFileSync(join(fixture, "reshoot.png"), replacement);
  const reshot = await addChangeMedia(fixture, path, { caption, light: "reshoot.png" });
  expect(readFileSync(reshot.paths[0]!)).toEqual(replacement);
  expect(readFileSync(lightPath)).toEqual(png);
  const content = readFileSync(join(fixture, path), "utf8");
  expect(content.endsWith(`---\n\n${body}`)).toBe(true);
  expect(readUnreleasedChangesWithMedia([{ path, content }])[0]?.media).toEqual([
    reshot.item,
    other.item,
  ]);
});

test("reuses the original stored file and refuses to overwrite a corrupt object", () => {
  const file = readMediaFile(join(fixture, "light.png"));
  const target = storeMediaFile(store, file);
  const inode = statSync(target).ino;
  expect(storeMediaFile(store, file)).toBe(target);
  expect(statSync(target).ino).toBe(inode);

  const corrupt = Buffer.alloc(file.data.length);
  writeFileSync(target, corrupt);
  expect(() => storeMediaFile(store, file)).toThrow("already exists with different contents");
  expect(readFileSync(target)).toEqual(corrupt);
});

test.each([
  ["broken.png", Buffer.from("not a PNG"), "valid PNG header"],
  ["broken.mp4", Buffer.from("000000246674797069736f6d00000000", "hex"), "valid MP4 header"],
  ["motion.gif", Buffer.alloc(0), /ffmpeg.*scale=.*libx264.*yuv420p.*faststart.*-an/u],
  ["unsupported.svg", Buffer.alloc(0), "must be a PNG or MP4 file"],
])("rejects invalid source %s", (name, bytes, error) => {
  const asset = join(fixture, name);
  writeFileSync(asset, bytes);
  expect(() => readMediaFile(asset)).toThrow(error);
});

test.each([
  ["light.png", 8_000_000],
  ["dark.mp4", 20_000_000],
])("enforces the size limit for %s", (name, maxBytes) => {
  const asset = join(fixture, name);
  truncateSync(asset, maxBytes + 1);
  expect(() => readMediaFile(asset)).toThrow(`must be at most ${maxBytes / 1_000_000} MB`);
});

test("checks for referenced files when the local store exists and CI is unset", async () => {
  vi.stubEnv("CI", undefined);
  const added = await addChangeMedia(fixture, path, {
    caption: "Review a change",
    light: "light.png",
  });
  const changes = readUnreleasedChangesWithMedia([
    { path, content: readFileSync(join(fixture, path), "utf8") },
  ]);
  expect(() => checkLocalChangeMedia(fixture, changes)).not.toThrow();
  rmSync(added.paths[0]!);
  expect(() => checkLocalChangeMedia(fixture, changes)).toThrow(
    /changes\/added\/2026-11-26-example\.md.*missing.*vp run media:add/u,
  );

  vi.stubEnv("CI", "true");
  expect(() => checkLocalChangeMedia(fixture, changes)).not.toThrow();
  vi.stubEnv("CI", undefined);
  rmSync(store, { recursive: true });
  expect(() => checkLocalChangeMedia(fixture, changes)).not.toThrow();
});

test("adds and reshoots a published entry's picture using the stable tag", async () => {
  git(fixture, "init", "-q", "-b", "main");
  writeFileSync(join(fixture, path), "An entry.\n");
  git(fixture, "add", "changes");
  git(fixture, "commit", "-q", "-m", "Release source");
  git(fixture, "tag", "v0.2.0");
  rmSync(join(fixture, path));
  writeFileSync(
    join(fixture, "CHANGELOG.md"),
    formatChangelog([
      {
        version: "0.2.0",
        date: "2026-11-26",
        headline: "A release",
        sections: [{ kind: "added", entries: ["An entry."] }],
      },
    ]),
  );
  writeBackfill(fixture, "# Added pictures\n{}\n");
  const caption = 'Review: "Ready"';
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      join(import.meta.dirname, "add.ts"),
      "--",
      "--release",
      "0.2.0",
      "example",
      "--caption",
      caption,
      "--light",
      "light.png",
    ],
    { cwd: fixture, encoding: "utf8" },
  );
  const first = readMediaFile(join(fixture, "light.png"));
  expect(output).toContain(join(store, first.name));
  expect(readFileSync(join(fixture, RELEASE_MEDIA_PATH), "utf8")).toContain(
    '# Added pictures\n"0.2.0":\n  example:\n',
  );

  const reshot = await addReleaseMedia(fixture, "0.2.0", "example", { caption, dark: "dark.mp4" });
  const attachments = releaseMediaAttachments(readReleaseMedia(fixture));
  expect(attachments.map(({ media }) => media)).toEqual([[reshot.item]]);
  expect(readFileSync(reshot.paths[0]!)).toEqual(mp4);
  expect(readFileSync(join(store, first.name))).toEqual(png);
  await expect(
    addReleaseMedia(fixture, "0.2.0", "typo", { caption, light: "light.png" }),
  ).rejects.toThrow(/typo.*does not match a change slug/u);

  vi.stubEnv("CI", undefined);
  expect(() => checkLocalChangeMedia(fixture, attachments)).not.toThrow();
  rmSync(reshot.paths[0]!);
  expect(() => checkLocalChangeMedia(fixture, attachments)).toThrow(
    /release-media\.yaml.*v0\.2\.0, example.*missing/u,
  );
  vi.stubEnv("CI", "true");
  expect(() => checkLocalChangeMedia(fixture, attachments)).not.toThrow();
});

test("publishes references from the selected ref and prunes only media unreferenced across worktrees, branches and tags", () => {
  const change = (media: string) =>
    `---\nmedia:\n  - caption: A picture\n    light: ${media}\n---\nAn entry.\n`;
  const other = `${fixture}-worktree`;
  try {
    git(fixture, "init", "-q", "-b", "main");
    git(fixture, "commit", "-q", "--allow-empty", "-m", "Start");
    expect(mediaFilesAtRef(fixture, "main")).toEqual([]);
    // A tag can be the last remaining reference to its pictures.
    git(fixture, "checkout", "-q", "-b", "tag-source");
    writeBackfill(fixture, backfill(name("e")));
    git(fixture, "add", RELEASE_MEDIA_PATH);
    git(fixture, "commit", "-q", "-m", "Tag pictures");
    git(fixture, "tag", "with-pictures");
    git(fixture, "checkout", "-q", "main");
    git(fixture, "branch", "-D", "tag-source");
    // A branch that is not checked out anywhere still holds its pictures.
    git(fixture, "checkout", "-q", "-b", "draft");
    writeFileSync(join(fixture, "changes/added/2026-11-26-branch.md"), change(name("a")));
    writeBackfill(fixture, backfill(name("f")));
    git(fixture, "add", "changes", RELEASE_MEDIA_PATH);
    git(fixture, "commit", "-q", "-m", "Draft");
    git(fixture, "checkout", "-q", "main");
    // So does an edit not committed yet in another worktree.
    git(fixture, "worktree", "add", "-q", "-b", "work", other);
    mkdirSync(join(other, "changes/fixed"), { recursive: true });
    writeFileSync(join(other, "changes/fixed/2026-11-26-work.md"), change(name("b", "mp4")));
    writeBackfill(other, `Still editing: [${name("7")}\n`);
    expect(mediaFilesAtRef(other, "draft")).toEqual([name("a"), name("f")]);
    expect(mediaFilesAtRef(other, "with-pictures")).toEqual([name("e")]);

    mkdirSync(store, { recursive: true });
    const referenced = [name("a"), name("b", "mp4"), name("e"), name("f"), name("7")];
    for (const file of [...referenced, name("c"), name("d")]) {
      writeFileSync(join(store, file), "picture");
    }
    const now = Date.now();
    const ages = { [name("d")]: 0 } as Record<string, number>;
    const stored = storedMedia(store).map((file) => ({
      ...file,
      stored: now - (ages[file.name] ?? 30) * 86_400_000,
    }));

    expect(referencedMedia(fixture)).toEqual(new Set(referenced));
    expect(
      orphanedMedia(stored, referencedMedia(fixture), now, 14).map(({ name }) => name),
    ).toEqual([name("c")]);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
