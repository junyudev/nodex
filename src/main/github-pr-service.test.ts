import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createGhPrComment,
  readGhCliStatus,
  readGhPrComments,
  readGhPrStatus,
} from "./github-pr-service";

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

describe("github PR service", () => {
  test("returns a typed disabled state when GitHub PR review is unavailable", async () => {
    const cwd = createTempDir("nodex-gh-pr-missing-");
    process.env.PATH = "";

    const status = await readGhCliStatus({ cwd });
    const prStatus = await readGhPrStatus({ cwd });

    expect(status.available).toBe(false);
    expect(["missing-gh", "missing-remote", "not-authenticated"].includes(status.status)).toBe(
      true,
    );
    expect(prStatus.available).toBe(false);
    expect(prStatus.status).toBe("disabled");
    expect(prStatus.disabledReason).toBe(status.status);
  });

  test("reads pull request review comments from the inline comments API", async () => {
    const cwd = createTempDir("nodex-gh-pr-comments-");
    installFakeGhEnvironment(
      cwd,
      [
        "if (args[0] === '--version') process.exit(0);",
        "if (args[0] === 'auth' && args[1] === 'status') process.exit(0);",
        "if (args[0] === 'api') {",
        "  console.log(JSON.stringify([{ id: 12, path: 'src/example.ts', line: 8, side: 'RIGHT', start_line: 6, start_side: 'RIGHT', body: 'Tighten this', user: { login: 'octo' }, html_url: 'https://github.test/c/12', in_reply_to_id: 9, outdated: false }]));",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await readGhPrComments({ cwd, prNumber: 7 });

    expect(result.available).toBe(true);
    expect(result.comments.length).toBe(1);
    expect(result.comments[0]?.id).toBe("12");
    expect(result.comments[0]?.path).toBe("src/example.ts");
    expect(result.comments[0]?.line).toBe(8);
    expect(result.comments[0]?.side).toBe("RIGHT");
    expect(result.comments[0]?.startLine).toBe(6);
    expect(result.comments[0]?.startSide).toBe("RIGHT");
    expect(result.comments[0]?.replyToId).toBe("9");
    expect(result.comments[0]?.author).toBe("octo");
  });

  test("posts inline review comments through gh api with commit and range fields", async () => {
    const cwd = createTempDir("nodex-gh-pr-inline-");
    const logPath = installFakeGhEnvironment(
      cwd,
      [
        "if (args[0] === '--version') process.exit(0);",
        "if (args[0] === 'auth' && args[1] === 'status') process.exit(0);",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  console.log(JSON.stringify({ headRefOid: 'abc123' }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api') {",
        "  console.log(JSON.stringify({ html_url: 'https://github.test/c/99' }));",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
    );

    const result = await createGhPrComment({
      type: "inline",
      cwd,
      prNumber: 42,
      body: "Please change this",
      path: "src/example.ts",
      line: 12,
      side: "RIGHT",
      startLine: 10,
      startSide: "RIGHT",
    });
    const log = readFileSync(logPath, "utf8");

    expect(result.available).toBe(true);
    expect(result.url).toBe("https://github.test/c/99");
    expect(Boolean(log.includes("repos/{owner}/{repo}/pulls/42/comments"))).toBe(true);
    expect(Boolean(log.includes("commit_id=abc123"))).toBe(true);
    expect(Boolean(log.includes("path=src/example.ts"))).toBe(true);
    expect(Boolean(log.includes("line=12"))).toBe(true);
    expect(Boolean(log.includes("side=RIGHT"))).toBe(true);
    expect(Boolean(log.includes("start_line=10"))).toBe(true);
  });

  test("rejects empty pull request comment bodies before posting", async () => {
    const cwd = createTempDir("nodex-gh-pr-empty-");
    installFakeGhEnvironment(
      cwd,
      [
        "if (args[0] === '--version') process.exit(0);",
        "if (args[0] === 'auth' && args[1] === 'status') process.exit(0);",
        "process.exit(0);",
      ].join("\n"),
    );

    const result = await createGhPrComment({
      cwd,
      prNumber: 1,
      body: "   ",
    });

    expect(result.available).toBe(false);
    expect(result.disabledReason).toBe("error");
    expect(result.message).toBe("Pull request comment body is required.");
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
