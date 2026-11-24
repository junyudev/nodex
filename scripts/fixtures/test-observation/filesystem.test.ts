import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, exists, existsSync, openSync, read, readFile, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { open, opendir, readdir, readFile as readFilePromise } from "node:fs/promises";
import path from "node:path";
import { URL as NodeURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

test("reads fixture data through path, descriptor and promise APIs", async () => {
  const fixture = new NodeURL("./vitest.config.ts", import.meta.url);
  const contents = readFileSync(fixture);
  expect(await promisify(readFile)(fixture)).toEqual(contents);
  expect(await readFilePromise(fixture)).toEqual(contents);
  const handle = await open(fixture);
  try {
    expect(await handle.readFile()).toEqual(contents);
  } finally {
    await handle.close();
  }
  const fd = openSync(fixture, "r");
  try {
    const buffer = Buffer.alloc(contents.length);
    const result = await promisify(read)(fd, buffer, 0, buffer.length, 0);
    expect(result.buffer).toEqual(contents);
  } finally {
    closeSync(fd);
  }
});

test("looks up an absent path and lists fixtures", async () => {
  const directory = new NodeURL(".", import.meta.url);
  expect(existsSync(new NodeURL("./absent.fixture", directory))).toBe(false);
  expect(await promisify(exists)(new NodeURL("./also-absent.fixture", directory))).toBe(false);
  expect(await readdir(directory)).toContain("vitest.config.ts");
  const opened = await opendir(directory);
  try {
    expect(await opened.read()).toBeTruthy();
  } finally {
    await opened.close();
  }
});

test("reads back its own output", () => {
  const file = path.join(import.meta.dirname, "created-" + process.pid + ".fixture");
  writeFileSync(file, "generated");
  try {
    expect(readFileSync(file, "utf8")).toBe("generated");
  } finally {
    unlinkSync(file);
  }
});

test("spawns the current Node executable", async () => {
  const [code] = await once(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }), "exit");
  expect(code).toBe(0);
});
