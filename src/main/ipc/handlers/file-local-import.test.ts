import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { collectLocalFileCandidates, readLocalFile } from "./file-local-import";

describe("local File import", () => {
  test("expands mixed files and folders into one deterministic logical-path batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-page-file-import-"));
    try {
      const looseFile = path.join(root, "notes.txt");
      const folder = path.join(root, "references");
      await fs.mkdir(path.join(folder, "nested"), { recursive: true });
      await Promise.all([
        fs.writeFile(looseFile, "notes"),
        fs.writeFile(path.join(folder, "api.md"), "api"),
        fs.writeFile(path.join(folder, "nested", "schema.json"), "{}"),
      ]);

      const candidates = await collectLocalFileCandidates([looseFile, folder, looseFile]);

      expect(candidates.map(({ logicalPath }) => logicalPath)).toEqual([
        "notes.txt",
        "references/api.md",
        "references/nested/schema.json",
      ]);
      expect(candidates.map(({ byteLength }) => byteLength)).toEqual([5, 3, 2]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlink before returning a partial directory batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-page-file-import-"));
    try {
      const folder = path.join(root, "references");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "api.md"), "api");
      await fs.symlink(path.join(folder, "api.md"), path.join(folder, "alias.md"));

      await expect(collectLocalFileCandidates([folder])).rejects.toThrow(
        "references/alias.md is a symbolic link",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("reads through one no-follow file handle and rejects direct symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nodex-page-file-import-"));
    try {
      const filePath = path.join(root, "notes.txt");
      const aliasPath = path.join(root, "notes-alias.txt");
      await fs.writeFile(filePath, "stable bytes");
      await fs.symlink(filePath, aliasPath);

      await expect(readLocalFile(filePath)).resolves.toEqual(Buffer.from("stable bytes"));
      await expect(readLocalFile(aliasPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
