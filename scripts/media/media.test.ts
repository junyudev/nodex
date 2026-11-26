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
import { addChangeMedia } from "./add";
import { describeMedia, imageVariantWidths } from "./encode";
import { orphanedMedia, referencedMedia, storedMedia } from "./prune";
import { checkLocalChangeMedia, readMediaFile, storeMediaFile } from "./store";

let fixture: string;
let store: string;
const path = "changes/added/2026-11-26-example.md";
const body = "An entry with **detail**.  \r\n  Wrapped line.\r\n\r\n";
const png = Buffer.from("89504e470d0a1a0a", "hex");
const mp4 = Buffer.from("000000146674797069736f6d0000000069736f6d", "hex");

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

test("prunes only pictures that no worktree, branch or tag mentions once their grace period ends", () => {
  const name = (digit: string, extension = "png") => `${digit.repeat(64)}.${extension}`;
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
  const change = (media: string) =>
    `---\nmedia:\n  - caption: A picture\n    light: ${media}\n---\nAn entry.\n`;
  const other = `${fixture}-worktree`;
  try {
    git(fixture, "init", "-q", "-b", "main");
    git(fixture, "commit", "-q", "--allow-empty", "-m", "Start");
    // A branch that is not checked out anywhere still holds its pictures.
    git(fixture, "checkout", "-q", "-b", "draft");
    writeFileSync(join(fixture, "changes/added/2026-11-26-branch.md"), change(name("a")));
    git(fixture, "add", "changes");
    git(fixture, "commit", "-q", "-m", "Draft");
    git(fixture, "checkout", "-q", "main");
    // So does an edit not committed yet in another worktree.
    git(fixture, "worktree", "add", "-q", "-b", "work", other);
    mkdirSync(join(other, "changes/fixed"), { recursive: true });
    writeFileSync(join(other, "changes/fixed/2026-11-26-work.md"), change(name("b", "mp4")));

    mkdirSync(store, { recursive: true });
    for (const file of [name("a"), name("b", "mp4"), name("c"), name("d")]) {
      writeFileSync(join(store, file), "picture");
    }
    const now = Date.now();
    const ages = { [name("d")]: 0 } as Record<string, number>;
    const stored = storedMedia(store).map((file) => ({
      ...file,
      stored: now - (ages[file.name] ?? 30) * 86_400_000,
    }));

    expect(referencedMedia(fixture)).toEqual(new Set([name("a"), name("b", "mp4")]));
    expect(
      orphanedMedia(stored, referencedMedia(fixture), now, 14).map(({ name }) => name),
    ).toEqual([name("c")]);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
