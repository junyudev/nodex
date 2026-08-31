import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { validateCodexSchemaToolArchivePaths } from "./codex-schema-tool";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("rejects links before extracting a schema tool archive", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-codex-schema-archive-"));
  roots.push(root);
  const payload = path.join(root, "payload");
  mkdirSync(payload);
  writeFileSync(path.join(payload, "codex-aarch64-apple-darwin"), "binary\n", { mode: 0o755 });
  symlinkSync("codex-aarch64-apple-darwin", path.join(payload, "codex-link"));
  const archivePath = path.join(root, "schema-tool.tar.gz");
  execFileSync("/usr/bin/tar", [
    "-czf",
    archivePath,
    "-C",
    payload,
    "codex-aarch64-apple-darwin",
    "codex-link",
  ]);

  expect(() => validateCodexSchemaToolArchivePaths(archivePath)).toThrow(
    "only regular files and directories",
  );
});
