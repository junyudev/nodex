import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const executeNode = (args: string[], cwd = process.cwd(), ci = "1") =>
  promisify(execFile)(process.execPath, args, {
    cwd,
    env: { ...process.env, CI: ci },
    timeout: 15_000,
  }).then(
    () => ({ code: 0, output: "" }),
    (error: unknown) => {
      const failure = error as { code: number; stderr: string; stdout: string };
      return { code: failure.code, output: failure.stderr + failure.stdout };
    },
  );

it("initializes committed Markdown in the cold bundled entry before rejecting execution", async () => {
  const paidGuard = "Supervised paid CLI evaluation is local-only";
  const launch = await executeNode([
    "--import",
    "tsx",
    path.resolve("scripts/agent-eval/launch.ts"),
  ]);
  expect(launch.code).toBe(1);
  expect(launch.output).toContain(paidGuard);

  const entry = path.resolve(".generated/agent-eval/run.cjs");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "nodex-agent-eval-markdown-"));
  const wasmRelative = "src/shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm";
  const wasmFixture = path.join(fixture, wasmRelative);
  try {
    const missing = await executeNode([entry], fixture);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("ENOENT");
    expect(missing.output).toContain(wasmFixture);
    expect(missing.output).not.toContain(paidGuard);

    await mkdir(path.dirname(wasmFixture), { recursive: true });
    await writeFile(wasmFixture, "invalid Wasm");
    const invalid = await executeNode([entry], fixture);
    expect(invalid.code).toBe(1);
    expect(invalid.output).toContain("WebAssembly.Module");
    expect(invalid.output).not.toContain(paidGuard);

    await copyFile(path.resolve(wasmRelative), wasmFixture);
    const valid = await executeNode([entry], fixture);
    expect(valid.code).toBe(1);
    expect(valid.output).toContain(paidGuard);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }

  const invalidArguments = await executeNode([entry, "--case", "__invalid__"], process.cwd(), "");
  expect(invalidArguments.code).toBe(1);
  expect(invalidArguments.output).toContain("Unknown case or invalid variant count");
});
