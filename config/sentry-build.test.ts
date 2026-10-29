import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";

let directory: string;
let entry: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nodex-sentry-build-"));
  const sdk = join(directory, "sdk.mjs");
  entry = join(directory, "entry.cjs");
  // Keep the installed plugin and its writeBundle/error handling intact. Only
  // the outbound SDK is replaced; no credentials or network calls are needed.
  await writeFile(
    sdk,
    `
    import { readFileSync, readdirSync } from "node:fs";
    import { join } from "node:path";
    export const calls = [];
    export function createSentrySDK() {
      return {
        release: {
          create: async ({ orgVersion }) => {
            calls.push({ operation: "release", release: orgVersion });
            if (process.argv[2] === "release-failure") throw new Error("fixture release rejected");
          },
          "set-commits": async () => {},
          finalize: async () => {},
        },
        sourcemap: {
          upload: async ({ directory, release }) => {
            const names = readdirSync(directory);
            const map = JSON.parse(readFileSync(join(directory, names.find(name => name.endsWith(".map"))), "utf8"));
            calls.push({ operation: "upload", release, files: names.length, debugId: map.debug_id });
            if (process.argv[2] === "upload-failure") throw new Error("fixture upload rejected");
          },
        },
      };
    }
  `,
  );
  await build({
    stdin: {
      contents: `
        import { mkdirSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { runInNewContext } from "node:vm";
        import { createSentryPlugins } from "./config/sentry-build";
        import { calls } from "sentry";
        const main = async () => {
          const [plugin] = createSentryPlugins();
          const output = join(process.cwd(), "out", "main");
          mkdirSync(output, { recursive: true });
          const chunk = plugin.renderChunk("globalThis.fixtureValue = 42;", {
            fileName: "entry.js", isEntry: true, facadeModuleId: "entry.ts",
          });
          const context = {};
          runInNewContext(chunk.code, context);
          writeFileSync(join(output, "entry.js"), chunk.code);
          writeFileSync(join(output, "entry.js.map"), String(chunk.map));
          try {
            await plugin.writeBundle({ dir: output }, {});
            console.log(JSON.stringify({ outcome: "resolved", calls, release: context.SENTRY_RELEASE?.id }));
          } catch (error) {
            console.log(JSON.stringify({ outcome: "rejected", error: error.message, calls }));
            process.exitCode = 1;
          }
        };
        void main();
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    alias: { sentry: sdk },
    external: ["vite"],
    outfile: entry,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    logLevel: "silent",
  });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function runBuildHook(mode: string) {
  const cwd = await mkdtemp(join(directory, `${mode}-`));
  const result = await promisify(execFile)(process.execPath, [entry, mode], {
    cwd,
    env: {
      NODE_ENV: "production",
      SENTRY_AUTH_TOKEN: "fixture-only-token",
      SENTRY_ORG: "fixture-only-org",
      SENTRY_PROJECT: "fixture-only-project",
      SENTRY_RELEASE: "nodex@0.5.0",
    },
    timeout: 15_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
  const output = result.stdout.trim().split("\n").at(-1);
  if (!output) throw new Error(`Missing build hook result: ${result.stderr}`);
  const receipt = JSON.parse(output) as {
    outcome: "resolved" | "rejected";
    error?: string;
    release?: string;
    calls: { operation: string; release: string; files?: number; debugId?: string }[];
  };
  return { ...result, receipt };
}

test("rejects the production build when the pinned plugin's source-map upload fails", async () => {
  const result = await runBuildHook("upload-failure");
  expect(result.receipt).toMatchObject({ outcome: "rejected", error: "fixture upload rejected" });
  expect(result.code).toBe(1);
  expect(result.receipt.calls).toEqual([
    { operation: "release", release: "nodex@0.5.0" },
    { operation: "upload", release: "nodex@0.5.0", files: 2, debugId: expect.any(String) },
  ]);
});

test("stops before uploading when the pinned plugin cannot register the release", async () => {
  const result = await runBuildHook("release-failure");
  expect(result.receipt).toMatchObject({ outcome: "rejected", error: "fixture release rejected" });
  expect(result.code).toBe(1);
  expect(result.receipt.calls).toEqual([{ operation: "release", release: "nodex@0.5.0" }]);
});

test("accepts uploaded debug-ID pairs for the same release injected into the app", async () => {
  const result = await runBuildHook("success");
  expect(result.code).toBe(0);
  expect(result.receipt).toMatchObject({ outcome: "resolved", release: "nodex@0.5.0" });
  expect(result.receipt.calls).toEqual([
    { operation: "release", release: "nodex@0.5.0" },
    { operation: "upload", release: "nodex@0.5.0", files: 2, debugId: expect.any(String) },
  ]);
  expect(result.stdout).toContain("Successfully uploaded source maps to Sentry");
});
