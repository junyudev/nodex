import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication } from "playwright";
import { desktopBuildTarget } from "../desktop-build-target";
import { terminateWindowsProcessTree } from "../../src/main/process-tree";
import { verifyWindowsArchitectureClosure } from "../windows-pe.mjs";
import {
  acquireIsolatedRunLease,
  ISOLATED_RUN_ID_ENV,
  readIsolatedRunClaim,
} from "../../src/main/core-client/isolated-run-ownership";
import { readCoreArtifactDigest } from "../../src/main/core-client/core-artifact";
import { CoreClient } from "../../src/main/core-client/core-client";
import { readCoreRuntimeConnection } from "../../src/main/core-client/runtime-descriptor";
import { cleanupIsolatedCore } from "../isolated-core-cleanup";
import {
  AGENT_RUNTIME_STARTUP_PROBE_ENV,
  AGENT_RUNTIME_STARTUP_EVIDENCE_FILE,
  parseAgentRuntimeStartupEvidence,
} from "../../src/shared/agent-runtime-startup-evidence";

const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
const failureDetails = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);
const protocolKey = "HKCU\\Software\\Classes\\nodex";
const assertProcessStopped = (pid: number): void => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Maintenance left process ${pid} running`);
};

const installationListenerAddresses = (installation: string): string[] => {
  const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = $env:NODEX_PROBE_INSTALL_ROOT.TrimEnd('\\') + '\\'
$images = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) }).ProcessId
$addresses = @(Get-NetTCPConnection -State Listen | Where-Object { $images -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalAddress -Unique)
ConvertTo-Json -InputObject $addresses -Compress
`;
  const addresses: unknown = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      {
        env: { ...process.env, NODEX_PROBE_INSTALL_ROOT: installation },
        encoding: "utf8",
        // NetTCPIP's first-use CIM provider import is cold on clean Windows hosts.
        // This audit is independent of the 30-second uninstall acceptance budget.
        timeout: 30_000,
      },
    ),
  );
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.some((address: unknown) => address !== "127.0.0.1" && address !== "::1")
  )
    throw new Error("Installed Nodex listeners must all use loopback");
  return addresses as string[];
};
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
  const profile = join(root, "Profile 用户");
  mkdirSync(profile);
  let runId = randomUUID();
  let lease = acquireIsolatedRunLease({ nodexHome: profile, runId, supervisorPid: process.pid });
  const failures: unknown[] = [];
  let installed = false;
  let child: ChildProcess | undefined;
  let application: ElectronApplication | undefined;
  let upgradeEvidence: unknown;
  let detachedCoreBeforeUninstall: number | undefined;
  let output = "";
  let evidence: unknown;
  let uninstallEvidence: unknown;
  const cleanup = async (): Promise<void> => {
    let uninstallCompleted = false;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        // Native handles verify settlement even when a descendant exits during termination.
        await Promise.all([
          once(child, "close", { signal: AbortSignal.timeout(10_000) }),
          terminateWindowsProcessTree(child.pid, "SIGKILL"),
        ]);
      } catch (error) {
        failures.push(error);
      }
    }
    if (installed || existsSync(installRoot)) {
      try {
        const uninstallers = readdirSync(installRoot).filter((name) =>
          /^Uninstall.*\.exe$/iu.test(name),
        );
        if (uninstallers.length !== 1) throw new Error("Installed NSIS uninstaller is missing");
        // Start-Process -Wait waits for descendants too, including NSIS's relocated
        // TEMP uninstaller. The install directory disappears before shortcut cleanup.
        const command = `
$ErrorActionPreference = 'Stop'
$uninstaller = Start-Process -FilePath $env:NODEX_PROBE_UNINSTALLER -ArgumentList '/S', '/currentuser' -Wait -PassThru
exit $uninstaller.ExitCode
`;
        const uninstallStarted = Date.now();
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(command, "utf16le").toString("base64"),
          ],
          {
            env: { ...process.env, NODEX_PROBE_UNINSTALLER: join(installRoot, uninstallers[0]!) },
            stdio: "inherit",
            timeout: 30_000,
          },
        );
        if (detachedCoreBeforeUninstall !== undefined)
          assertProcessStopped(detachedCoreBeforeUninstall);
        const shortcuts = [
          join(appData, "Microsoft/Windows/Start Menu/Programs/Nodex.lnk"),
          join(process.env.USERPROFILE!, "Desktop/Nodex.lnk"),
        ].filter(existsSync);
        const remainingProtocol = queryProtocol();
        uninstallEvidence = {
          completed: true,
          elapsedMs: Date.now() - uninstallStarted,
          detachedCoreBeforeUninstall,
          filesRemoved: !existsSync(installRoot),
          protocolRemoved: remainingProtocol === null,
          shortcutsRemoved: shortcuts.length === 0,
          profilePreserved: existsSync(profile),
        };
        if (existsSync(installRoot))
          throw new Error(`Uninstall left files: ${readdirSync(installRoot).join(", ")}`);
        if (remainingProtocol) throw new Error("Uninstall left the nodex:// protocol registration");
        if (shortcuts.length) throw new Error(`Uninstall left shortcuts: ${shortcuts.join(", ")}`);
        if (!existsSync(profile)) throw new Error("Uninstall removed the Profile");
        uninstallCompleted = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!uninstallCompleted) {
      try {
        // Only a failed uninstall needs the supervisor's fallback Core cleanup.
        const cleanup = await cleanupIsolatedCore({
          lease,
          nodexHome: profile,
          runId,
          releaseLeaseOnSuccess: false,
        });
        if (!cleanup.safeToDeleteRunRoot)
          failures.push(new Error(`Core cleanup failed: ${cleanup.reason ?? cleanup.status}`));
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      lease.release();
    } catch (error) {
      failures.push(error);
    }
    writeFileSync(join(artifacts, "startup.log"), output);
    const logRoot = join(profile, "logs");
    if (existsSync(logRoot))
      for (const name of readdirSync(logRoot).filter((entry) => entry.endsWith(".log")))
        writeFileSync(join(artifacts, name), readFileSync(join(logRoot, name)));
    writeFileSync(
      join(artifacts, "result.json"),
      `${JSON.stringify({ evidence, upgrade: upgradeEvidence, uninstall: uninstallEvidence, failures: failures.map(failureDetails) }, null, 2)}\n`,
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
    const images = verifyWindowsArchitectureClosure(installRoot, target.arch, { installed: true });
    const registration = queryProtocol();
    if (!registration?.includes(`"${executable}" "%1"`) || !registration.includes("URL Protocol"))
      throw new Error("NSIS did not register nodex:// for the current user");
    const core = join(installRoot, "resources/bin/nodex-core.exe");
    const expectedCoreSha256 = readCoreArtifactDigest(
      core,
      join(installRoot, "resources/bin/rust-core-runtime.json"),
    );
    const launchEnvironment = { ...process.env };
    delete launchEnvironment.NODE_OPTIONS;
    delete launchEnvironment.ELECTRON_RUN_AS_NODE;
    evidence = {
      target: target.key,
      installer: installers[0],
      images: images.length,
      protocolRegistered: true,
      coreSha256: expectedCoreSha256,
    };
    const launchInstalled = async (): Promise<void> => {
      application = await _electron.launch({
        executablePath: executable,
        args: [`--user-data-dir=${join(root, "electron-user-data")}`],
        timeout: 60_000,
        cwd: root,
        env: {
          ...launchEnvironment,
          NODEX_LOG_CONSOLE: "true",
          NODEX_LOG_FILE: "true",
          NODEX_LOG_LEVEL: "debug",
          NODEX_HOME: profile,
          CODEX_HOME: join(profile, "agent"),
          NODEX_INITIAL_PROJECTS_DIR: join(root, "workspace"),
          NODEX_SENTRY_ENABLED: "false",
          NODEX_TELEMETRY_ENABLED: "false",
          NODEX_CORE_IDLE_TIMEOUT_MS: "600000",
          [ISOLATED_RUN_ID_ENV]: runId,
          [AGENT_RUNTIME_STARTUP_PROBE_ENV]: "1",
        },
      });
      child = application.process();
      // Playwright wraps Electron in cmd.exe on Windows; claims identify Main.
      const hostPid = await application.evaluate(() => process.pid);
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
        const claim = readIsolatedRunClaim(profile);
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(
            `Installed Nodex exited before Core and Agent readiness (exit ${child.exitCode}, host phase: ${claim?.phase ?? "unclaimed"})`,
          );
        const agentFile = join(profile, "run", AGENT_RUNTIME_STARTUP_EVIDENCE_FILE);
        if (existsSync(agentFile) && statSync(agentFile).size > 4_096)
          throw new Error("Agent Runtime startup diagnostic exceeds its bounded size");
        const agent = existsSync(agentFile)
          ? parseAgentRuntimeStartupEvidence(JSON.parse(readFileSync(agentFile, "utf8")), {
              runId,
              hostPid,
            })
          : null;
        if (agent && agent.nodeSource !== "standalone")
          throw new Error("Windows Agent Runtime did not use the verified standalone Node runtime");
        if (claim?.phase === "ready" && agent) {
          if (claim.runId !== runId || claim.hostPid !== hostPid)
            throw new Error("Installed Nodex readiness belongs to another host generation");
          const { descriptor } = readCoreRuntimeConnection(profile);
          if (!descriptor.endpoint.startsWith("\\\\.\\pipe\\nodex-core-"))
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
          if (queryProtocol() !== registration)
            throw new Error("Launching Nodex changed the installer's protocol registration");
          evidence = {
            protocolRegistered: true,
            protocolPreservedAfterLaunch: true,
            namedPipe: true,
            target: target.key,
            installer: installers[0],
            images: images.length,
            hostPid,
            corePid: descriptor.pid,
            coreSha256: expectedCoreSha256,
            authenticated: Boolean(client.handshake),
            agent,
            listenerAddresses: installationListenerAddresses(installRoot),
          };
          break;
        }
        if (Date.now() >= deadline)
          throw new Error(
            `Installed Nodex did not reach Core and Agent Runtime readiness within 60s (host phase: ${claim?.phase ?? "unclaimed"}, Agent Runtime: ${agent ? "ready" : "pending"}). Core must publish its named-pipe descriptor and the supervised Agent Runtime must complete its execution handshake.`,
          );
        await delay(100);
      }
    };
    const quitWithDetachedCore = async (): Promise<number> => {
      if (!application) throw new Error("Installed desktop is missing");
      // Playwright calls Electron app.quit(), exercising ordinary desktop shutdown.
      await application.close();
      const client = await CoreClient.connect({
        nodexHome: profile,
        clientKind: "native_cli",
        buildId: "windows-installer-detached-core-probe",
        requestTimeoutMs: 5_000,
      });
      await client.health();
      const { descriptor } = readCoreRuntimeConnection(profile);
      process.kill(descriptor.pid, 0);
      return descriptor.pid;
    };
    await launchInstalled();
    const oldCorePid = await quitWithDetachedCore();
    const upgradeStarted = Date.now();
    execFileSync(resolve("dist", installers[0]!), ["/S", "/currentuser"], {
      stdio: "inherit",
      timeout: 180_000,
    });
    upgradeEvidence = { completed: true, elapsedMs: Date.now() - upgradeStarted, oldCorePid };
    assertProcessStopped(oldCorePid);
    // Each launch needs a fresh host claim, while retaining the same Profile.
    lease.release();
    runId = randomUUID();
    lease = acquireIsolatedRunLease({ nodexHome: profile, runId, supervisorPid: process.pid });
    rmSync(join(profile, "run", AGENT_RUNTIME_STARTUP_EVIDENCE_FILE), { force: true });
    await launchInstalled();
    detachedCoreBeforeUninstall = await quitWithDetachedCore();
  } catch (error) {
    failures.push(error);
  } finally {
    await cleanup();
  }
  if (failures.length) throw new AggregateError(failures, failures.map(failureDetails).join("\n"));
  process.stdout.write(
    `Installed ${target.key} Nodex, verified authenticated Core and Agent Runtime readiness, and removed the installation.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
