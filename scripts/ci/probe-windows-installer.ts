import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopBuildTarget } from "../desktop-build-target";
import { verifyWindowsArchitectureClosure } from "../windows-pe.mjs";
import {
  acquireIsolatedRunLease,
  ISOLATED_RUN_ID_ENV,
  readIsolatedRunClaim,
} from "../../src/main/core-client/isolated-run-ownership";
import { CoreClient } from "../../src/main/core-client/core-client";
import { readCoreRuntimeConnection } from "../../src/main/core-client/runtime-descriptor";
import { cleanupIsolatedCore } from "../isolated-core-cleanup";

const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const protocolKey = "HKCU\\Software\\Classes\\nodex";
const queryProtocol = (): string | null => {
  try {
    return execFileSync("reg.exe", ["query", protocolKey, "/s"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) return null;
    throw error;
  }
};

async function main(): Promise<void> {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !["--arch", "--artifacts"].includes(key) || !value)
      throw new Error(
        "Usage: probe-windows-installer.ts --arch <x64|arm64> --artifacts <directory>",
      );
    options.set(key, value);
  }
  const target = desktopBuildTarget("win32", options.get("--arch"));
  if (process.platform !== "win32" || process.arch !== target.arch)
    throw new Error("Run the installer probe natively on the matching Windows runner");
  const root = resolve(options.get("--artifacts") ?? ".generated/windows-probe");
  const artifacts = join(root, "artifacts");
  if (existsSync(root))
    throw new Error(`Installer probe needs a fresh evidence directory: ${root}`);
  mkdirSync(artifacts, { recursive: true });
  const installers = readdirSync("dist").filter((name) =>
    name.endsWith(`-win-${target.arch}-setup.exe`),
  );
  if (installers.length !== 1)
    throw new Error(`Expected one ${target.key} installer, found ${installers.length}`);
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (!localAppData || !appData) throw new Error("LOCALAPPDATA and APPDATA are required");
  const installRoot = join(localAppData, "Programs", "nodex");
  if (existsSync(installRoot) || queryProtocol())
    throw new Error(
      "Installer probe refuses to replace an existing Nodex installation or protocol registration",
    );
  const profile = join(root, "profile");
  mkdirSync(profile);
  const runId = randomUUID();
  const lease = acquireIsolatedRunLease({ nodexHome: profile, runId, supervisorPid: process.pid });
  const failures: unknown[] = [];
  let installed = false;
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  let evidence: unknown;
  const cleanup = async (): Promise<void> => {
    if (child?.pid && child.exitCode === null) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } catch (error) {
        failures.push(error);
      }
      await delay(500);
    }
    try {
      const cleanup = await cleanupIsolatedCore({ lease, nodexHome: profile, runId });
      if (!cleanup.safeToDeleteRunRoot)
        failures.push(new Error(`Core cleanup failed: ${cleanup.reason ?? cleanup.status}`));
    } catch (error) {
      failures.push(error);
    }
    try {
      lease.release();
    } catch (error) {
      failures.push(error);
    }
    if (installed || existsSync(installRoot)) {
      try {
        const uninstallers = readdirSync(installRoot).filter((name) =>
          /^Uninstall.*\.exe$/iu.test(name),
        );
        if (uninstallers.length !== 1) throw new Error("Installed NSIS uninstaller is missing");
        // NSIS may move itself to TEMP; wait below for that cleanup process to finish.
        execFileSync(join(installRoot, uninstallers[0]!), ["/S", "/currentuser"], {
          stdio: "inherit",
          timeout: 180_000,
        });
        const deadline = Date.now() + 30_000;
        while (existsSync(installRoot) && Date.now() < deadline) await delay(200);
        if (existsSync(installRoot))
          throw new Error(`Uninstall left files: ${readdirSync(installRoot).join(", ")}`);
        if (queryProtocol()) throw new Error("Uninstall left the nodex:// protocol registration");
        for (const shortcut of [
          join(appData, "Microsoft/Windows/Start Menu/Programs/Nodex.lnk"),
          join(process.env.USERPROFILE!, "Desktop/Nodex.lnk"),
        ])
          if (existsSync(shortcut)) throw new Error(`Uninstall left a shortcut: ${shortcut}`);
      } catch (error) {
        failures.push(error);
      }
    }
    writeFileSync(join(artifacts, "startup.log"), output);
    const logRoot = join(profile, "logs");
    if (existsSync(logRoot))
      for (const name of readdirSync(logRoot).filter((entry) => entry.endsWith(".log")))
        writeFileSync(join(artifacts, name), readFileSync(join(logRoot, name)));
    writeFileSync(
      join(artifacts, "result.json"),
      `${JSON.stringify({ evidence, failures: failures.map(String) }, null, 2)}\n`,
    );
  };
  try {
    execFileSync(resolve("dist", installers[0]!), ["/S", "/currentuser"], {
      stdio: "inherit",
      timeout: 180_000,
    });
    installed = true;
    const executable = join(installRoot, "Nodex.exe");
    if (!existsSync(executable))
      throw new Error(`NSIS did not install Nodex per-user: ${executable}`);
    const images = verifyWindowsArchitectureClosure(installRoot, target.arch);
    const registration = queryProtocol();
    if (!registration?.includes("Nodex.exe"))
      throw new Error("NSIS did not register nodex:// for the current user");
    const core = join(installRoot, "resources/bin/nodex-core.exe");
    const expectedCoreSha256 = sha256(core);
    const manifest = JSON.parse(
      readFileSync(join(installRoot, "resources/bin/rust-core-runtime.json"), "utf8"),
    ) as { binaries: { name: string; sourceSha256: string }[] };
    if (
      manifest.binaries.find((binary) => binary.name === "nodex-core")?.sourceSha256 !==
      expectedCoreSha256
    )
      throw new Error("Installed Core differs from its staged runtime identity");
    child = spawn(executable, [`--user-data-dir=${join(root, "electron-user-data")}`], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODEX_HOME: profile,
        CODEX_HOME: join(profile, "agent"),
        NODEX_INITIAL_PROJECTS_DIR: join(root, "workspace"),
        NODEX_SENTRY_ENABLED: "false",
        NODEX_TELEMETRY_ENABLED: "false",
        NODEX_CORE_IDLE_TIMEOUT_MS: "30000",
        [ISOLATED_RUN_ID_ENV]: runId,
      },
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-64_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-64_000);
    });
    child.on("error", (error) => {
      output += `\n${error.message}`;
    });
    const deadline = Date.now() + 60_000;
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Installed Nodex exited before Core readiness (exit ${child.exitCode})`);
      const claim = readIsolatedRunClaim(profile);
      if (claim?.phase === "ready") {
        if (claim.runId !== runId || claim.hostPid !== child.pid)
          throw new Error("Installed Nodex readiness belongs to another host generation");
        const { descriptor } = readCoreRuntimeConnection(profile);
        if (!descriptor.socket_path.startsWith("\\\\.\\pipe\\"))
          throw new Error(
            "Windows Core must publish a named-pipe endpoint in its runtime descriptor",
          );
        if (descriptor.artifact.sha256 !== expectedCoreSha256)
          throw new Error("Running Core identity differs from the installed executable");
        const client = await CoreClient.connect({
          nodexHome: profile,
          clientKind: "native_cli",
          buildId: "windows-installer-probe",
          requestTimeoutMs: 10_000,
        });
        evidence = {
          target: target.key,
          installer: installers[0],
          images: images.length,
          hostPid: child.pid,
          corePid: descriptor.pid,
          coreSha256: expectedCoreSha256,
          authenticated: Boolean(client.handshake),
        };
        break;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Installed Nodex did not become ready within 60s (host phase: ${claim?.phase ?? "unclaimed"}). Windows Core must support named pipes and publish run/core/core.json; Electron liveness alone does not satisfy this probe.`,
        );
      await delay(100);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    await cleanup();
  }
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
  process.stdout.write(
    `Installed ${target.key} Nodex, verified authenticated Core readiness, and removed the installation.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
