import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { WindowsArchitecture } from "../desktop-build-target";
import type { PreparedElectronBuildManifest } from "../prepared-electron-build";
import { inspectOfficialAgentSkillsArtifact } from "../official-agent-skills-artifact.mjs";
import { assertPackagedPtyReceipt } from "../packaged-pty-probe.mjs";
import { installedPayloadInventory } from "../installed-payload.mjs";
import { runVitePlus } from "../vite-plus-command";
import { assertSourceIdentity } from "./distribution";
import { parseArchitectureBuildManifest, type ArchitectureBuildManifest } from "./bundle";
import { parseBuildIdentity, sha256File, type BuildIdentity } from "./model";
import { releaseBuildEnvironment, windowsInstallerName } from "./targets";

export function verifyWindowsPreparedIdentity(
  prepared: PreparedElectronBuildManifest,
  identity: BuildIdentity,
): void {
  if (
    prepared.source.state !== "clean" ||
    prepared.source.baseCommit !== identity.sourceSha ||
    prepared.source.baseTree !== identity.sourceTree ||
    prepared.product.version !== identity.version ||
    JSON.stringify(parseBuildIdentity(prepared.buildIdentity)) !== JSON.stringify(identity)
  ) {
    throw new Error("Windows prepared build does not match the exact clean Build Identity.");
  }
}

/** Installed runtime execution is mandatory before any installer enters a bundle. */
export function assertWindowsInstalledProbe(
  value: unknown,
  architecture: WindowsArchitecture,
): void {
  const probe = value as {
    failures?: unknown[];
    evidence?: unknown;
    upgrade?: unknown;
    uninstall?: unknown;
    normalQuit?: unknown;
    packagedPty?: unknown;
  } | null;
  if (
    !probe ||
    !Array.isArray(probe.failures) ||
    probe.failures.length ||
    !probe.evidence ||
    !probe.upgrade ||
    !probe.uninstall ||
    !probe.normalQuit
  )
    throw new Error("Windows installed-app probe did not complete all maintenance checks.");
  const pty = assertPackagedPtyReceipt(probe.packagedPty);
  const addon = pty.addonPath.replaceAll("\\", "/");
  const node = pty.nodeExecutable.replaceAll("\\", "/");
  if (
    addon.slice(0, -"/agent-runtime/node_modules/node-pty".length).toLowerCase() !==
      node.slice(0, -"/node-runtime/node.exe".length).toLowerCase() ||
    pty.platform !== "win32" ||
    pty.architecture !== architecture ||
    !pty.addonPath
      .replaceAll("\\", "/")
      .endsWith("/resources/agent-runtime/node_modules/node-pty") ||
    !pty.nodeExecutable.replaceAll("\\", "/").endsWith("/resources/node-runtime/node.exe")
  )
    throw new Error("Windows PTY probe did not execute the installed runtime closure.");
}

const toolVersion = (command: string, args: string[]): string => {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    return "unavailable";
  }
};

/** One native build/package/probe path serves validation, stable releases and Nightly. */
export function buildWindowsDistribution(options: {
  readonly architecture: WindowsArchitecture;
  readonly cwd: string;
  readonly identityPath: string;
  readonly outputDirectory: string;
  readonly release: boolean;
}): ArchitectureBuildManifest {
  if (process.platform !== "win32" || process.arch !== options.architecture)
    throw new Error("Windows distribution requires the matching native runner and Node CPU.");
  const cwd = resolve(options.cwd);
  const identityPath = resolve(options.identityPath);
  const identity = parseBuildIdentity(JSON.parse(readFileSync(identityPath, "utf8")));
  assertSourceIdentity(cwd, identity);
  const output = resolve(options.outputDirectory);
  if (existsSync(output) && readdirSync(output).length > 0)
    throw new Error("Windows distribution output must be empty.");
  const updates = options.release ? "enabled" : "disabled";
  const env = {
    ...releaseBuildEnvironment(identity, identityPath),
    NODEX_APP_UPDATES: updates,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
  const task = (...args: string[]): void => runVitePlus(args, { cwd, env });
  task("run", "build");
  task("run", `stage:native-runtime:win:${options.architecture}`);
  task("run", "verify:runtime:win", ".generated/codex-runtime", options.architecture);
  task(
    "run",
    "verify:runtime:win",
    `.generated/node-runtime/win32-${options.architecture}`,
    options.architecture,
  );
  task("run", "package:win:prepared", options.architecture);
  assertSourceIdentity(cwd, identity);

  const appRoot = join(
    cwd,
    "dist",
    options.architecture === "x64" ? "win-unpacked" : "win-arm64-unpacked",
  );
  const resources = join(appRoot, "resources");
  const preparedPath = join(cwd, ".generated/prepared-electron-build.json");
  const prepared = JSON.parse(readFileSync(preparedPath, "utf8")) as PreparedElectronBuildManifest;
  verifyWindowsPreparedIdentity(prepared, identity);
  if (sha256File(join(resources, "prepared-electron-build.json")) !== sha256File(preparedPath))
    throw new Error("Windows payload contains a different prepared build.");
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
  const { extractFile } = appBuilderRequire("@electron/asar") as {
    extractFile: (archive: string, name: string) => Buffer;
  };
  const metadata = JSON.parse(
    extractFile(join(resources, "app.asar"), "package.json").toString(),
  ) as { version?: unknown };
  if (metadata.version !== identity.version)
    throw new Error("Windows packaged app version does not match its Build Identity.");
  const agentSkills = inspectOfficialAgentSkillsArtifact(join(resources, "agent-skills"));
  if (
    agentSkills.manifestSha256 !== prepared.agentSkills.manifestSha256 ||
    agentSkills.treeSha256 !== prepared.agentSkills.treeSha256
  )
    throw new Error("Windows packaged Skills do not match the prepared build.");

  // A failed installed-app probe never produces a distributable architecture bundle.
  task(
    "exec",
    "tsx",
    "scripts/ci/probe-windows-installer.ts",
    "--arch",
    options.architecture,
    "--artifacts",
    ".generated/windows-probe",
  );
  const probePath = join(cwd, ".generated/windows-probe/artifacts/result.json");
  assertWindowsInstalledProbe(JSON.parse(readFileSync(probePath, "utf8")), options.architecture);
  mkdirSync(output, { recursive: true });
  const name = windowsInstallerName(identity.version, options.architecture);
  const installerPath = join(output, name);
  copyFileSync(
    join(cwd, "dist", `Nodex-${identity.version}-win-${options.architecture}-setup.exe`),
    installerPath,
  );
  const architecture = `windows-${options.architecture}` as const;
  const artifacts = [
    {
      architecture,
      name,
      bytes: statSync(installerPath).size,
      sha256: sha256File(installerPath),
      role: "windows-installer" as const,
    },
  ];
  const runtimeLocks = {
    agentSha256: sha256File(join(cwd, "resources/agent-runtime/codex-app-server.lock.json")),
    browserSha256: sha256File(join(cwd, "resources/browser-runtime/browser-runtime.lock.json")),
    sparkleSha256: sha256File(join(cwd, "resources/sparkle/sparkle.lock.json")),
    nodeSha256: sha256File(join(cwd, "resources/agent-runtime/node-runtime.lock.json")),
  };
  const provenancePath = join(output, "windows-build-provenance.json");
  writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        architecture,
        buildIdentity: identity,
        updates,
        runtimeLocks,
        artifacts,
        preparedManifestSha256: sha256File(preparedPath),
        installedProbeSha256: sha256File(probePath),
        payload: installedPayloadInventory(appRoot).files.map((file) => ({
          ...file,
          sha256: sha256File(join(appRoot, file.path)),
        })),
      },
      null,
      2,
    )}\n`,
  );
  copyFileSync(probePath, join(output, "installed-app-probe.json"));
  const manifest = parseArchitectureBuildManifest({
    schemaVersion: 3,
    architecture,
    updates,
    artifacts,
    runtimeLocks,
    agentSkills: { manifestSha256: agentSkills.manifestSha256, treeSha256: agentSkills.treeSha256 },
    preparedBuild: {
      generation: prepared.generationId,
      manifestSha256: sha256File(preparedPath),
      state: "clean",
    },
    packageProvenanceSha256: sha256File(provenancePath),
    buildIdentity: identity,
    sourceSha: identity.sourceSha,
    sourceTree: identity.sourceTree,
    version: identity.version,
    runner: {
      image: process.env.ImageOS ?? process.env.RUNNER_OS ?? "local",
      imageVersion: process.env.ImageVersion ?? "unknown",
      node: process.version,
      rust: toolVersion("rustc", ["--version"]),
      pnpm: process.env.npm_config_user_agent ?? "vite-plus",
    },
  });
  writeFileSync(join(output, "architecture-build.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
