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
import { checkLocalChangeMedia, readMediaFile, storeMediaFile } from "./store";

let fixture: string;
let store: string;
const path = "changes/added/2026-11-26-example.md";
const body = "An entry with **detail**.  \r\n  Wrapped line.\r\n\r\n";
const png = Buffer.from("89504e470d0a1a0a", "hex");
const mp4 = Buffer.from("000000146674797069736f6d0000000069736f6d", "hex");

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
