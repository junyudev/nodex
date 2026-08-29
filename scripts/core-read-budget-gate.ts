import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const READ_BUDGET_TESTS = [
  "read_budget_gate_large_fixture",
  "sidebar_section_large_window_budget",
] as const;

type ReadBudgetTest = (typeof READ_BUDGET_TESTS)[number];

function readProfileArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--profile");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error(
      "Usage: vp run core:read-budget-gate -- --profile .generated/<name> [--test <name>]",
    );
  }
  return value;
}

function readTestArgument(argv: readonly string[]): ReadBudgetTest {
  const index = argv.indexOf("--test");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) return "read_budget_gate_large_fixture";
  if (READ_BUDGET_TESTS.some((test) => test === value)) return value as ReadBudgetTest;
  throw new Error(`Unsupported read-budget test: ${value}`);
}

async function prepareTarget(rawTarget: string): Promise<string> {
  const repositoryRoot = await realpath(process.cwd());
  const generatedRoot = await realpath(path.join(repositoryRoot, ".generated"));
  const target = path.resolve(repositoryRoot, rawTarget);
  const relative = path.relative(generatedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Gate Profile must be a child of the repository .generated directory");
  }

  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Gate Profile target must be a real directory");
    }
    if ((await readdir(target)).length > 0) {
      throw new Error("Gate Profile target must be empty");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(target);
    } else {
      throw error;
    }
  }
  return await realpath(target);
}

async function prepareTemporaryTarget(test: ReadBudgetTest): Promise<string> {
  const repositoryRoot = await realpath(process.cwd());
  const generatedRootPath = path.join(repositoryRoot, ".generated");
  await mkdir(generatedRootPath, { recursive: true });
  const generatedRoot = await realpath(generatedRootPath);
  return await realpath(await mkdtemp(path.join(generatedRoot, `${test}-`)));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const test = readTestArgument(argv);
  const temporary = argv.includes("--temporary");
  const target = temporary
    ? await prepareTemporaryTarget(test)
    : await prepareTarget(readProfileArgument(argv));
  try {
    const child = spawn(
      "cargo",
      [
        "test",
        "-p",
        "nodex-core",
        "--all-features",
        "--lib",
        `read_budget_gate::${test}`,
        "--",
        "--exact",
        "--include-ignored",
        "--nocapture",
        "--test-threads=1",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODEX_READ_BUDGET_GATE_PROFILE: target,
        },
        stdio: "inherit",
      },
    );
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Read-budget gate terminated by ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    if (temporary) await rm(target, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
