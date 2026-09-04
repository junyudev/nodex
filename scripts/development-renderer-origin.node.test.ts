import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { resolveDevelopmentRendererPort } from "./development-renderer-origin";

test("reopens the existing cache origin and persists an explicit choice for ambiguous homes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nodex-origin-"));
  const nodexHome = path.join(root, ".nodex");
  const caches = path.join(nodexHome, "electron-session-data", "IndexedDB");
  try {
    await mkdir(path.join(caches, "http_localhost_51284.indexeddb.leveldb"), { recursive: true });
    await mkdir(path.join(caches, "http_localhost_51285.indexeddb.leveldb"));
    await expect(resolveDevelopmentRendererPort({ root, nodexHome })).rejects.toThrow(
      "Choose --renderer-port",
    );
    expect(await resolveDevelopmentRendererPort({ root, nodexHome, requestedPort: "51285" })).toBe(
      51285,
    );
    expect(await resolveDevelopmentRendererPort({ root, nodexHome })).toBe(51285);
    expect(
      JSON.parse(await readFile(path.join(root, "renderer-origin.json"), "utf8")),
    ).toMatchObject({ hostname: "localhost", port: 51285 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
