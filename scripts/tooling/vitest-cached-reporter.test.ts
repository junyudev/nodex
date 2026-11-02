import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const runNode = promisify(execFile);
const require = createRequire(import.meta.url);

// A separate process keeps the nested runner's stack interceptor outside this test runner.
const checkReporterStack = `
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { createVitest } = await import(pathToFileURL(process.argv[1]));
const root = process.argv[2];
const rounds = [];
for (const round of ["cold", "warm"]) {
  const ctx = await createVitest(
    { root, config: false, watch: false, reporters: [], fsModuleCache: true },
    { cacheDir: path.join(root, ".cache") },
  );
  try {
    const { default: Reporter } = await ctx.import(path.join(root, "cached-reporter.ts"));
    await assert.rejects(new Reporter().onTestRunEnd(), (error) => {
      assert.equal(error.message, "Original reporter failure: 警告");
      assert.match(error.stack, /Original reporter failure: 警告/);
      assert.match(error.stack, /cached-reporter\\.ts:3:\\d+/);
      return true;
    });
    rounds.push(round);
  } finally {
    await ctx.close();
  }
}
console.log(JSON.stringify(rounds));
`;

test("keeps a cached reporter's original rejection and TypeScript location visible", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nodex cached reporter "));
  try {
    await writeFile(
      path.join(directory, "cached-reporter.ts"),
      'export default class Reporter {\n  async onTestRunEnd() {\n    throw new Error("Original reporter failure: 警告");\n  }\n}\n',
    );
    const { stdout } = await runNode(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        checkReporterStack,
        require.resolve("vitest/node"),
        directory,
      ],
      { timeout: 20_000 },
    );
    expect(JSON.parse(stdout)).toEqual(["cold", "warm"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
