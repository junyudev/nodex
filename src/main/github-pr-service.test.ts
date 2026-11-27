import { afterEach, expect, test, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGhPrStatus } from "./github-pr-service";

const commandFixtures = vi.hoisted(() => new Map<string, string>());
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (
      command: string,
      args: readonly string[],
      options: import("node:child_process").ExecFileOptions,
      callback: (
        error: import("node:child_process").ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      const script = commandFixtures.get(command);
      return script
        ? original.execFile(
            process.execPath,
            [script, ...args],
            { ...options, encoding: "utf8" },
            callback,
          )
        : original.execFile(command, args, { ...options, encoding: "utf8" }, callback);
    },
  };
});

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installFakeGhEnvironment(cwd: string, scriptBody: string): string {
  const binDir = path.join(cwd, "bin");
  const logPath = path.join(cwd, "commands.log");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "git"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'remote' && args[1] === '-v') {",
      "  console.log('origin\\thttps://github.com/acme/project.git (fetch)');",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
    ].join("\n"),
  );
  writeFileSync(
    path.join(binDir, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const logPath = ${JSON.stringify(logPath)};`,
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(logPath, args.join('\\u0000') + '\\n');",
      scriptBody,
    ].join("\n"),
  );
  commandFixtures.set("git", path.join(binDir, "git"));
  commandFixtures.set("gh", path.join(binDir, "gh"));
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return logPath;
}

afterEach(() => {
  commandFixtures.clear();
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports an unavailable GitHub CLI when the process cannot be started", async () => {
  const cwd = createTempDir("nodex-gh-pr-missing-");
  process.env.PATH = cwd;

  const status = await readGhPrStatus({ cwd });

  expect(status).toMatchObject({
    available: false,
    status: "disabled",
    disabledReason: "missing-gh",
  });
});

test("reads the selected branch and retains the PR head repository for verification", async () => {
  const cwd = createTempDir("nodex-gh-pr-head-");
  const logPath = installFakeGhEnvironment(
    cwd,
    [
      "if (args[0] === '--version') process.exit(0);",
      "if (args[0] === 'auth') process.exit(0);",
      "if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify({number:42,title:'Fix login',url:'https://github.com/acme/project/pull/42',state:'OPEN',headRefName:'nodex-12-fix-login',headRepository:{name:'project'},headRepositoryOwner:{login:'fork-owner'}})); process.exit(0); }",
      "process.exit(1);",
    ].join("\n"),
  );
  const result = await readGhPrStatus({ cwd, headBranch: "nodex-12-fix-login" });
  expect(result).toMatchObject({
    prNumber: 42,
    headBranch: "nodex-12-fix-login",
    headRepositoryUrl: "https://github.com/fork-owner/project",
  });
  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split("\u0000"));
  expect(
    commands.some(
      (args) => args[0] === "pr" && args[1] === "view" && args[2] === "nodex-12-fix-login",
    ),
  ).toBe(true);
});
