import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  verifySourceTypeOwnership,
  verifySourceTypeOwnershipFixtures,
} from "./verify-source-type-ownership";

describe("source type ownership", () => {
  test("rejects unowned, shadowed, and runnable fixture sources while allowing raw program samples", () => {
    verifySourceTypeOwnershipFixtures();
  });

  test("checks newly untracked source files as well as the tracked compiler graph", () => {
    const directory = mkdtempSync(join(tmpdir(), "nodex-source-inventory-"));
    try {
      symlinkSync(
        resolve(import.meta.dirname, "../../node_modules"),
        join(directory, "node_modules"),
        "junction",
      );
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({ private: true, packageManager: "pnpm@12.15.0" }),
      );
      writeFileSync(
        join(directory, "tsconfig.json"),
        JSON.stringify({ files: [], references: [{ path: "./tsconfig.source.json" }] }),
      );
      writeFileSync(
        join(directory, "tsconfig.source.json"),
        JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ["tracked.ts"] }),
      );
      writeFileSync(join(directory, "tracked.ts"), "export const tracked = 1;\n");
      const initialized = spawnSync("git", ["init", "--quiet"], {
        cwd: directory,
        encoding: "utf8",
      });
      expect(initialized.status, initialized.stderr).toBe(0);
      const staged = spawnSync("git", ["add", "tracked.ts"], { cwd: directory, encoding: "utf8" });
      expect(staged.status, staged.stderr).toBe(0);
      expect(() => verifySourceTypeOwnership(directory)).not.toThrow();
      writeFileSync(join(directory, "new-untracked.mts"), "export const untracked = 2;\n");
      expect(() => verifySourceTypeOwnership(directory)).toThrow("new-untracked.mts");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
