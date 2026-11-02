import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { createVitest } = await import(pathToFileURL(process.argv[1]));
const root = process.argv[2];
const rounds = [];
const cacheDirectory = path.join(root, ".cache");
async function logCacheKeys(phase) {
  const entries = await readdir(cacheDirectory).catch((error) => ['<unavailable:' + error.code + '>']);
  console.error('[cache-keys:' + phase + '] ' + JSON.stringify(entries.sort()));
}
for (const round of ["cold", "warm"]) {
  console.error('[cache-round:' + round + ']');
  const ctx = await createVitest(
    {
      root,
      config: false,
      watch: false,
      reporters: [],
      fsModuleCache: true,
      fsModuleCachePath: cacheDirectory,
    },
  );
  try {
    await logCacheKeys(round + ":created");
    const { default: Reporter } = await ctx.import(path.join(root, "cached-reporter.ts"));
    await logCacheKeys(round + ":imported");
    await assert.rejects(new Reporter().onTestRunEnd(), (error) => {
      assert.equal(error.message, "Original reporter failure: 警告");
      assert.match(error.stack, /Original reporter failure: 警告/);
      assert.match(error.stack, /cached-reporter\\.ts:3:\\d+/);
      return true;
    });
    rounds.push(round);
  } finally {
    await ctx.close();
    await logCacheKeys(round + ":closed");
  }
}
console.log(JSON.stringify(rounds));
`;

test("keeps a cached reporter's original rejection and TypeScript location visible", async () => {
  // Keep both runners' cache keys tied to one physical fixture root.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "nodex cached reporter ")));
  try {
    await writeFile(
      path.join(directory, "cached-reporter.ts"),
      'export default class Reporter {\n  async onTestRunEnd() {\n    throw new Error("Original reporter failure: 警告");\n  }\n}\n',
    );
    const { stdout, stderr } = await runNode(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        checkReporterStack,
        require.resolve("vitest/node"),
        directory,
      ],
      { timeout: 20_000, env: { ...process.env, DEBUG: "vitest:cache:fs" } },
    );
    expect(JSON.parse(stdout)).toEqual(["cold", "warm"]);
    const diagnostics = stderr.match(/\[cache-round:cold\]([\s\S]*?)\[cache-round:warm\]([\s\S]*)/);
    expect(diagnostics, stderr).not.toBeNull();
    expect(diagnostics![1], stderr).toMatch(/\[write\][^\r\n]*cached-reporter\.ts/);
    expect(diagnostics![1], stderr).not.toMatch(/\[read\][^\r\n]*cached-reporter\.ts/);
    expect(diagnostics![2], stderr).toMatch(/\[read\][^\r\n]*cached-reporter\.ts/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
