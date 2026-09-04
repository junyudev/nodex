import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildClipboardBridge(architecture: "arm64" | "x64"): void {
  if (process.platform !== "darwin") throw new Error("Clipboard bridge requires macOS");
  const electronVersion = (
    JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      devDependencies: { electron: string };
    }
  ).devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/u.test(electronVersion)) throw new Error("Electron must be exactly pinned");
  const source = path.join(repositoryRoot, "native", "macos-clipboard");
  const buildRoot = path.join(repositoryRoot, ".generated", "clipboard-native-build", architecture);
  mkdirSync(path.join(buildRoot, "src"), { recursive: true });
  for (const file of ["binding.gyp", "src/nodex_clipboard.mm"]) {
    copyFileSync(path.join(source, file), path.join(buildRoot, file));
  }
  execFileSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve("node-gyp/bin/node-gyp.js"),
      "rebuild",
      "--directory",
      buildRoot,
      `--target=${electronVersion}`,
      `--arch=${architecture}`,
      "--dist-url=https://electronjs.org/headers",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "15.0" },
      stdio: "inherit",
    },
  );
  const binary = path.join(buildRoot, "build", "Release", "nodex_clipboard.node");
  const actual = execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf8" }).trim();
  if (actual !== (architecture === "arm64" ? "arm64" : "x86_64")) {
    throw new Error(`Clipboard bridge architecture mismatch: ${actual}`);
  }
  const output = path.join(repositoryRoot, ".generated", "clipboard-runtime", architecture);
  mkdirSync(output, { recursive: true });
  copyFileSync(binary, path.join(output, "nodex-clipboard.node"));
  chmodSync(path.join(output, "nodex-clipboard.node"), 0o755);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const architecture = process.argv[2] ?? process.arch;
  if (architecture !== "arm64" && architecture !== "x64") throw new Error("Expected arm64 or x64");
  buildClipboardBridge(architecture);
}
