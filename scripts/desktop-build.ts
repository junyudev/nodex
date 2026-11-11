import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBuildIdentity } from "./release/model";
import { desktopBuildTarget, type DesktopBuildTarget } from "./desktop-build-target";
import { runVitePlus } from "./vite-plus-command";
import { stageStandaloneNodeRuntime } from "./standalone-node-runtime";
import { stageCodexRuntime } from "./stage-codex-runtime";
import { windowsSigningConfiguration } from "./windows-signing";

const root = fileURLToPath(new URL("../", import.meta.url));
const task = (name: string, ...args: string[]) =>
  runVitePlus(["run", name, ...args], { cwd: root });
const tsx = (script: string, ...args: string[]) =>
  runVitePlus(["exec", "tsx", `scripts/${script}.ts`, ...args], { cwd: root });

function buildRust(target: DesktopBuildTarget, release: boolean, explicitTarget: boolean): void {
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      ...(release ? ["--release"] : []),
      ...(explicitTarget ? ["--target", target.rustTarget] : []),
      ...target.rustPackages.flatMap((name) => ["-p", name]),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        ...(target.platform === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: "15.0" } : {}),
      },
    },
  );
}

async function stageCodex(target: DesktopBuildTarget, cached: boolean): Promise<void> {
  const browserSource = `.generated/browser-runtime-source/${target.arch}`;
  if (target.runtime === "macos") task(`materialize:browser-runtime:mac:${target.arch}`);
  await stageCodexRuntime({
    targetPlatform: target.platform,
    targetArch: target.arch,
    outputPath: resolve(root, ".generated/codex-runtime"),
    reuseExisting: cached,
    ...(target.runtime === "macos"
      ? { browserRuntimeSourceRoot: resolve(root, browserSource) }
      : {}),
  });
  if (target.runtime === "windows") await stageStandaloneNodeRuntime(root, target.arch);
}

function buildMacBridges(target: DesktopBuildTarget): void {
  if (target.runtime !== "macos") return;
  for (const bridge of ["clipboard", "devicecheck", "notification"])
    task(`${bridge}-bridge:build`, target.arch);
}

async function stageNative(target: DesktopBuildTarget): Promise<void> {
  buildMacBridges(target);
  await stageCodex(target, false);
  stageRust(target);
  /* Core and CLI are staged before the platform-specific runtime set. */
  if (target.runtime !== "macos") return;
  task(`stage:sparkle-runtime:mac:${target.arch}`);
  task(`materialize:workspace-runtime:mac:${target.arch}`);
}

function stageRust(target: DesktopBuildTarget): void {
  buildRust(target, true, true);
  tsx(
    "stage-rust-core",
    "--target-platform",
    target.platform,
    "--target-arch",
    target.arch,
    "--out",
    ".generated/codex-runtime",
  );
}

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const [platform = process.platform, arch = process.arch] = args.filter(
    (arg) => arg !== "--cached",
  );
  const target = desktopBuildTarget(platform, arch);
  if (operation === "stage-codex") return stageCodex(target, args.includes("--cached"));
  if (operation === "stage-native") return stageNative(target);
  if (operation === "stage-rust") return stageRust(target);
  if (operation === "rust-dev" || operation === "rust-release")
    return buildRust(target, operation === "rust-release", false);
  if (operation === "core-dev") {
    buildMacBridges(target);
    if (target.runtime === "macos") {
      task("appshot-helper:build:dev");
      task("dictation-helper:build:dev");
    }
    task("core:binaries:prepare:dev");
    return;
  }
  if (operation === "build") {
    buildMacBridges(target);
    if (target.runtime === "macos") task("appshot-helper:build:dev");
    tsx("prepared-electron-build", "build");
    task("renderer-bootstrap:verify-build");
    return;
  }
  if (operation === "package" || operation === "package-prepared") {
    if (target.platform !== process.platform || target.arch !== process.arch)
      throw new Error(
        `Package ${target.key} natively on the matching host; cross-packaging is unsupported`,
      );
    if (operation === "package") {
      task("build");
      await stageNative(target);
    }
    tsx("prepared-electron-build", "verify");
    const identityPath = process.env.NODEX_BUILD_IDENTITY_PATH;
    const identity = identityPath
      ? parseBuildIdentity(JSON.parse(readFileSync(identityPath, "utf8")))
      : null;
    const signing =
      target.platform === "win32" ? windowsSigningConfiguration({ kind: "unsigned" }) : {};
    runVitePlus(
      [
        "exec",
        "electron-builder",
        "--config",
        "config/electron-builder.yml",
        target.platform === "win32" ? "--win" : "--mac",
        target.platform === "win32" ? "nsis" : "dmg",
        `--${target.arch}`,
        "--publish",
        "never",
        ...(identity
          ? [
              `--config.extraMetadata.version=${identity.version}`,
              `--config.buildVersion=${identity.buildVersion}`,
            ]
          : []),
        ...Object.entries(signing).map(([key, value]) => `--config.win.${key}=${String(value)}`),
      ],
      { cwd: root },
    );
    return;
  }

  throw new Error(
    "Usage: desktop-build.ts <build|core-dev|rust-dev|rust-release|stage-codex|stage-native|package|package-prepared> [darwin|win32] [arm64|x64] [--cached]",
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
