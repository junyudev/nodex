#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER_EXECUTABLE_NAME = "NodexBrowserRuntimeProbe";
const LAUNCHER_SOURCE = `#!/bin/sh
project_root="$1"
status_path="$2"
output_path="$3"
shift 3
cd "$project_root" || exit 1
"$@" >"$output_path" 2>&1
status=$?
printf '%s\\n' "$status" >"$status_path"
exit "$status"
`;

export function buildBrowserRuntimeProbeInvocation(
  projectRoot: string,
  arguments_: readonly string[],
  nodeExecutable: string = process.execPath,
): { command: string; args: string[] } {
  const root = path.resolve(projectRoot);
  return {
    args: [
      path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(root, "scripts", "probe-browser-runtime.ts"),
      ...arguments_,
    ],
    command: nodeExecutable,
  };
}

function writeLauncherApp(root: string): string {
  const appPath = path.join(root, "Nodex Browser Runtime Probe.app");
  const contentsPath = path.join(appPath, "Contents");
  const executableDirectory = path.join(contentsPath, "MacOS");
  const executablePath = path.join(executableDirectory, LAUNCHER_EXECUTABLE_NAME);
  mkdirSync(executableDirectory, { recursive: true });
  writeFileSync(
    path.join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${LAUNCHER_EXECUTABLE_NAME}</string>
  <key>CFBundleIdentifier</key><string>app.jyu.nodex.browser-runtime-probe</string>
  <key>CFBundleName</key><string>Nodex Browser Runtime Probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSBackgroundOnly</key><true/>
</dict></plist>
`,
  );
  writeFileSync(executablePath, LAUNCHER_SOURCE);
  chmodSync(executablePath, 0o755);
  return appPath;
}

function runInDesktopLaunchContext(
  projectRoot: string,
  invocation: { command: string; args: readonly string[] },
): number {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-browser-runtime-probe-launcher-"));
  const outputPath = path.join(temporaryRoot, "output.log");
  const statusPath = path.join(temporaryRoot, "status.txt");
  try {
    const appPath = writeLauncherApp(temporaryRoot);
    const launched = spawnSync(
      "/usr/bin/open",
      [
        "-W",
        "-n",
        appPath,
        "--args",
        path.resolve(projectRoot),
        statusPath,
        outputPath,
        invocation.command,
        ...invocation.args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = readFileSync(outputPath, "utf8");
    process.stdout.write(output);
    if (launched.error) throw launched.error;
    if (launched.status !== 0) {
      throw new Error(
        `Browser runtime probe launcher failed: ${launched.stderr.trim() || launched.status}`,
      );
    }
    const status = Number.parseInt(readFileSync(statusPath, "utf8").trim(), 10);
    if (!Number.isSafeInteger(status) || status < 0 || status > 255) {
      throw new Error("Browser runtime probe launcher returned an invalid status");
    }
    return status;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function runDirectly(
  projectRoot: string,
  invocation: { command: string; args: readonly string[] },
): number {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 1;
  }
  return result.status ?? 1;
}

function resolveProbeNodeExecutable(arguments_: readonly string[]): string {
  const resourcesPathIndex = arguments_.indexOf("--resources-path");
  const resourcesPath = resourcesPathIndex < 0 ? null : arguments_[resourcesPathIndex + 1]?.trim();
  if (!resourcesPath) return process.execPath;

  const bundledNode = path.join(path.resolve(resourcesPath), "browser-runtime", "bin", "node");
  if (!existsSync(bundledNode)) {
    throw new Error(`Browser runtime probe node is missing: ${bundledNode}`);
  }
  return bundledNode;
}

export function shouldUseDesktopLaunchContext(
  platform: NodeJS.Platform,
  arguments_: readonly string[],
): boolean {
  return platform === "darwin" && arguments_.includes("--conformance");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const projectRoot = path.resolve(process.cwd());
  const arguments_ = process.argv.slice(2);
  const invocation = buildBrowserRuntimeProbeInvocation(
    projectRoot,
    arguments_,
    resolveProbeNodeExecutable(arguments_),
  );
  process.exitCode = shouldUseDesktopLaunchContext(process.platform, arguments_)
    ? runInDesktopLaunchContext(projectRoot, invocation)
    : runDirectly(projectRoot, invocation);
}
