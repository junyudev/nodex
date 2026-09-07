import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

/** Compile the canonical headless document codec with normal build-time stylesheet handling. */
async function launch(): Promise<void> {
  const root = process.cwd();
  const outputDirectory = path.join(root, ".generated/agent-eval");
  const output = path.join(outputDirectory, "run.cjs");
  const blockNoteRoot = path.join(root, "third_party/blocknote/packages/core");
  const manifest = JSON.parse(await readFile(path.join(blockNoteRoot, "package.json"), "utf8")) as {
    exports: Record<string, { import: string }>;
  };
  await mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: [path.join(root, "scripts/agent-eval/run.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    external: ["electron", "node-pty", "playwright", "@playwright/test"],
    loader: { ".css": "empty" },
    logLevel: "warning",
    plugins: [
      {
        name: "headless-blocknote-source",
        setup(builder) {
          builder.onResolve({ filter: /^@blocknote\/core(?:\/.*)?$/ }, ({ path: specifier }) => {
            const subpath = specifier.replace("@blocknote/core", ".");
            const entry = manifest.exports[subpath];
            if (!entry) return { errors: [{ text: `Unknown BlockNote entry: ${specifier}` }] };
            return { path: path.resolve(blockNoteRoot, entry.import) };
          });
        },
      },
    ],
  });
  const child = spawn(process.execPath, [output, ...process.argv.slice(2)], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

void launch().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
