import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
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
import { promisify } from "node:util";
import { _electron, type ElectronApplication } from "playwright";
import { windowsUpdateInstallerCommand } from "../../src/main/windows-update-handoff";
import {
  WINDOWS_STARTUP_ARGUMENT,
  WINDOWS_LOGIN_ITEM_NAME,
  windowsLoginItemEnabled,
} from "../../src/main/windows-desktop-policy";
import {
  readBrowserRuntimeReleaseLock,
  resolveBrowserRuntimeReleaseLockPath,
} from "../browser-runtime-release-lock";
import { desktopBuildTarget } from "../desktop-build-target";
import { terminateWindowsProcessTree } from "../../src/main/process-tree";
import { restorePackagedBrowserRuntimeClosure } from "../restore-packaged-runtime-closure.mjs";
import { verifyWindowsArchitectureClosure } from "../windows-pe.mjs";
import { installedPayloadInventory } from "../installed-payload.mjs";
import { runPackagedPtyProbe, type PackagedPtyReceipt } from "../packaged-pty-probe.mjs";
import { probeWindowsDesktopTools } from "../testing/windows-desktop-tools.test-support";
import { isProcessRunning } from "../tooling/process";
import { assertDesktopRuntimePayload } from "../desktop-runtime-payload.mjs";
import { claudeSdkModuleUrl } from "../../src/main/platform/node/ClaudeSdkModule";
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

import { prepareNativeArtifacts, requiredNativeExecutable } from "../testing/native-artifacts";

const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
// Maintenance must let the host drain owned pipes and release exited process handles.
const runMaintenance = promisify(execFile);
const failureDetails = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const processFailure = Object.fromEntries(
    ["code", "signal", "killed", "stdout", "stderr"].flatMap((key) => {
      const value = Reflect.get(error, key);
      return value === undefined ? [] : [[key, String(value).slice(-16_000)]];
    }),
  );
  return [
    error.stack ?? error.message,
    ...(Object.keys(processFailure).length ? [JSON.stringify(processFailure)] : []),
  ].join("\n");
};
const protocolKey = "HKCU\\Software\\Classes\\nodex";
const startupRunKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const startupApprovedKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const queryStartupValue = (key: string): string | null => {
  try {
    return execFileSync("reg.exe", ["query", key, "/v", WINDOWS_LOGIN_ITEM_NAME], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 1) return null;
    throw error;
  }
};
const assertProcessStopped = (pid: number): void => {
  if (isProcessRunning(pid)) throw new Error(`Maintenance left process ${pid} running`);
};
const waitForProcessStopped = async (pid: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline)
      throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
    await delay(25);
  }
};

interface InstallationInspection {
  readonly processes: { pid: number; commandLine: string; createdAt: string }[];
  readonly listenerAddresses: string[];
}
let inspectionExecutable: string | undefined;
const inspectInstallation = (installation: string): InstallationInspection =>
  JSON.parse(
    execFileSync(
      inspectionExecutable ?? requiredNativeExecutable("windows-maintenance"),
      ["--inspect", installation],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    ),
  ) as InstallationInspection;

export const installationListenerAddresses = (installation: string): string[] => {
  const addresses = inspectInstallation(installation).listenerAddresses;
  if (
    !addresses.length ||
    addresses.some((address) => address !== "127.0.0.1" && address !== "::1")
  )
    throw new Error("Installed Nodex listeners must all use loopback");
  return addresses;
};
const installationProcesses = (installation: string) => inspectInstallation(installation).processes;

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
    if (!key || !["--arch", "--artifacts", "--installer-timeout-ms"].includes(key) || !value)
      throw new Error(
        "Usage: probe-windows-installer.ts --arch <x64|arm64> --artifacts <directory> [--installer-timeout-ms <milliseconds>]",
      );
    options.set(key, value);
  }
  const installerTimeoutMs = Number(options.get("--installer-timeout-ms") ?? 180_000);
  if (
    !Number.isSafeInteger(installerTimeoutMs) ||
    installerTimeoutMs < 45_000 ||
    installerTimeoutMs > 1_800_000
  )
    throw new Error("Installer probe timeout must be between 45000 and 1800000 milliseconds");
  const target = desktopBuildTarget("win32", options.get("--arch"));
  if (process.platform !== "win32" || process.arch !== target.arch)
    throw new Error("Run the installer probe natively on the matching Windows runner");
  const root = resolve(options.get("--artifacts") ?? ".generated/windows-probe");
  const artifacts = join(root, "artifacts");
  if (existsSync(root))
    throw new Error(`Installer probe needs a fresh evidence directory: ${root}`);
  mkdirSync(artifacts, { recursive: true });
  const installers = readdirSync("dist").filter(
    (name) =>
      name.endsWith(`-win-${target.arch}-setup.exe`) ||
      name.endsWith(`-windows-${target.arch}.exe`),
  );
  if (installers.length !== 1)
    throw new Error(`Expected one ${target.key} installer, found ${installers.length}`);
  const localAppData = process.env.LOCALAPPDATA;
  const appData = process.env.APPDATA;
  if (!localAppData || !appData) throw new Error("LOCALAPPDATA and APPDATA are required");
  const installRoot = join(localAppData, "Programs", "nodex");
  inspectionExecutable = process.env.NODEX_TEST_WINDOWS_MAINTENANCE_EXECUTABLE
    ? requiredNativeExecutable("windows-maintenance")
    : (await prepareNativeArtifacts(["windows-maintenance"], { repositoryRoot: process.cwd() }))
        .executables["windows-maintenance"];
  const maintenanceLog = join(localAppData, "Nodex", "installer-maintenance.log");
  const captureMaintenanceLog = (operation: string): string => {
    if (!existsSync(maintenanceLog)) return "No installer maintenance log was written.";
    const details = readFileSync(maintenanceLog, "utf8").slice(-16_000);
    writeFileSync(join(artifacts, `maintenance-${operation}.log`), details);
    return details;
  };
  const recordPhase = (phase: string): void => {
    writeFileSync(
      join(artifacts, "phase.json"),
      JSON.stringify({ phase, startedAt: new Date().toISOString() }),
    );
  };
  const startMenuShortcut = join(appData, "Microsoft/Windows/Start Menu/Programs/Nodex.lnk");
  if (
    existsSync(installRoot) ||
    queryProtocol() ||
    queryStartupValue(startupRunKey) ||
    queryStartupValue(startupApprovedKey)
  )
    throw new Error(
      "Installer probe refuses to replace an existing Nodex installation or protocol registration",
    );
  const profile = join(root, "Profile 用户");
  mkdirSync(profile);
  const profileMarker = join(profile, "installer-probe.txt");
  const profileContent = randomUUID();
  writeFileSync(profileMarker, profileContent);
  const profileDatabase = join(profile, "nodex.db");
  const isProfilePreserved = (requireDatabase = true): boolean =>
    (!requireDatabase || existsSync(profileDatabase)) &&
    existsSync(profileMarker) &&
    readFileSync(profileMarker, "utf8") === profileContent;
  let runId = randomUUID();
  let lease = acquireIsolatedRunLease({ nodexHome: profile, runId, supervisorPid: process.pid });
  const failures: unknown[] = [];
  let installed = false;
  let child: ChildProcess | undefined;
  let application: ElectronApplication | undefined;
  let desktopPid: number | undefined;
  const desktopCloses: Promise<void>[] = [];
  let normalQuitEvidence: unknown;
  let installationEvidence: unknown;
  let desktopTools:
    | Awaited<ReturnType<typeof probeWindowsDesktopTools>>
    | { status: "skipped: candidate assets" }
    | undefined;
  let upgradeEvidence: unknown;
  let updateHandoffEvidence: unknown;
  let detachedCoreBeforeUninstall: number | undefined;
  let output = "";
  let evidence: unknown;
  let packagedPty: PackagedPtyReceipt | undefined;
  let uninstallEvidence: unknown;
  const cleanup = async (): Promise<void> => {
    let uninstallCompleted = false;
    if (
      child?.pid &&
      child.exitCode === null &&
      child.signalCode === null &&
      (desktopPid === undefined || isProcessRunning(desktopPid))
    ) {
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
      recordPhase("uninstall");
      try {
        const uninstallers = readdirSync(installRoot).filter((name) =>
          /^Uninstall.*\.exe$/iu.test(name),
        );
        if (uninstallers.length !== 1) throw new Error("Installed NSIS uninstaller is missing");
        // NSIS relocates its uninstaller to TEMP and its bootstrap exits first. That process
        // removes files before shortcuts and registrations, so wait for the whole end state.
        const uninstallStarted = Date.now();
        const requireProfileDatabase =
          normalQuitEvidence !== undefined || existsSync(profileDatabase);
        const remainingShortcuts = () =>
          [startMenuShortcut, join(process.env.USERPROFILE!, "Desktop/Nodex.lnk")].filter(
            existsSync,
          );
        const startupValuesRemoved = () =>
          queryStartupValue(startupRunKey) === null &&
          queryStartupValue(startupApprovedKey) === null;
        rmSync(maintenanceLog, { force: true });
        await runMaintenance(join(installRoot, uninstallers[0]!), ["/S", "/currentuser"], {
          timeout: installerTimeoutMs,
        });
        while (
          (existsSync(installRoot) ||
            remainingShortcuts().length > 0 ||
            queryProtocol() !== null ||
            !startupValuesRemoved()) &&
          Date.now() - uninstallStarted < installerTimeoutMs
        ) {
          await delay(250);
        }
        captureMaintenanceLog("uninstall");
        if (detachedCoreBeforeUninstall !== undefined)
          assertProcessStopped(detachedCoreBeforeUninstall);
        const shortcuts = remainingShortcuts();
        const remainingProtocol = queryProtocol();
        const filesRemoved = !existsSync(installRoot);
        const protocolRemoved = remainingProtocol === null;
        const shortcutsRemoved = shortcuts.length === 0;
        const profilePreserved = isProfilePreserved(requireProfileDatabase);
        const startupRemoved = startupValuesRemoved();
        uninstallEvidence = {
          completed:
            filesRemoved &&
            protocolRemoved &&
            shortcutsRemoved &&
            profilePreserved &&
            startupRemoved,
          startupRemoved,
          elapsedMs: Date.now() - uninstallStarted,
          detachedCoreBeforeUninstall,
          desktopExit: detachedCoreBeforeUninstall === undefined ? undefined : "forced",
          filesRemoved,
          protocolRemoved,
          shortcutsRemoved,
          profilePreserved,
        };
        if (!filesRemoved)
          throw new Error(`Uninstall left files: ${readdirSync(installRoot).join(", ")}`);
        if (!protocolRemoved) throw new Error("Uninstall left the nodex:// protocol registration");
        if (!startupRemoved)
          throw new Error("Uninstall left owned login registration or startup approval");
        if (!shortcutsRemoved) throw new Error(`Uninstall left shortcuts: ${shortcuts.join(", ")}`);
        if (!profilePreserved) throw new Error("Uninstall removed the Profile");
        uninstallCompleted = true;
      } catch (error) {
        failures.push(
          new Error(`${failureDetails(error)}\n${captureMaintenanceLog("uninstall-failed")}`),
        );
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
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(desktopCloses),
        new Promise<never>((_, reject) => {
          closeTimeout = setTimeout(
            () => reject(new Error("Playwright cleanup did not settle after Core maintenance")),
            5_000,
          );
        }),
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      clearTimeout(closeTimeout);
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
      `${JSON.stringify({ installation: installationEvidence, evidence, desktopTools, packagedPty, normalQuit: normalQuitEvidence, upgrade: upgradeEvidence, updateHandoff: updateHandoffEvidence, uninstall: uninstallEvidence, failures: failures.map(failureDetails) }, null, 2)}\n`,
    );
  };
  try {
    recordPhase("install");
    const installStarted = Date.now();
    rmSync(maintenanceLog, { force: true });
    await runMaintenance(resolve("dist", installers[0]!), ["/S", "/currentuser"], {
      timeout: installerTimeoutMs,
    });
    captureMaintenanceLog("install");
    installationEvidence = {
      completed: true,
      elapsedMs: Date.now() - installStarted,
      installerBytes: statSync(resolve("dist", installers[0]!)).size,
      timeoutMs: installerTimeoutMs,
    };
    installed = true;
    const executable = join(installRoot, "Nodex.exe");
    if (!existsSync(executable))
      throw new Error(`NSIS did not install Nodex per-user: ${executable}`);
    packagedPty = runPackagedPtyProbe({
      nodeExecutable: join(installRoot, "resources/node-runtime/node.exe"),
      addonPath: join(installRoot, "resources/agent-runtime/node_modules/node-pty"),
    });
    const payload = installedPayloadInventory(installRoot);
    writeFileSync(
      join(artifacts, "installed-payload.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    console.log(`Installed ${target.key}: ${payload.bytes} bytes in ${payload.fileCount} files.`);
    const claudeExecutable = assertDesktopRuntimePayload({
      resourcesPath: join(installRoot, "resources"),
      platform: "win32",
      arch: target.arch,
    });
    const claudeVersion = execFileSync(claudeExecutable, ["--version"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
    const desktopToolsRoot = join(installRoot, "resources/browser-runtime");
    const asset = readBrowserRuntimeReleaseLock(resolveBrowserRuntimeReleaseLockPath(process.cwd()))
      .assets[target.key];
    if ((asset.url !== null) !== existsSync(desktopToolsRoot))
      throw new Error("Installed Desktop Tool presence does not match the release lock");
    if (asset.url !== null) {
      restorePackagedBrowserRuntimeClosure({
        sourceBrowserRoot: desktopToolsRoot,
        packagedBrowserRoot: desktopToolsRoot,
        windowsArch: target.arch,
        expectedManifestSha256: asset.manifestSha256,
        restore: false,
      });
    }
    const images = verifyWindowsArchitectureClosure(installRoot, target.arch, {
      installed: true,
      desktopToolsRoot,
      nodeHost: join(installRoot, "Nodex.exe"),
    });
    const registration = queryProtocol();
    if (!registration?.includes(`"${executable}" "%1"`) || !registration.includes("URL Protocol"))
      throw new Error("NSIS did not register nodex:// for the current user");
    const loginRegistration = queryStartupValue(startupRunKey);
    if (!loginRegistration?.includes(`"${executable}" ${WINDOWS_STARTUP_ARGUMENT}`))
      throw new Error("NSIS did not register per-user background startup");
    const core = join(installRoot, "resources/bin/nodex-core.exe");
    desktopTools = existsSync(desktopToolsRoot)
      ? await probeWindowsDesktopTools({
          location: { isPackaged: true, resourcesPath: join(installRoot, "resources") },
          boundary: installRoot,
          launcher: core,
        })
      : { status: "skipped: candidate assets" };
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
    const installedEnvironment = () => ({
      ...launchEnvironment,
      NODEX_LOG_CONSOLE: "true",
      NODEX_LOG_FILE: "true",
      NODEX_LOG_LEVEL: "debug",
      NODEX_HOME: profile,
      CODEX_HOME: join(profile, "agent"),
      NODEX_PROJECTS_DIR: join(root, "workspace"),
      NODEX_SENTRY_ENABLED: "false",
      NODEX_TELEMETRY_ENABLED: "false",
      NODEX_CORE_IDLE_TIMEOUT_MS: String(Math.max(600_000, installerTimeoutMs * 2)),
      [ISOLATED_RUN_ID_ENV]: runId,
      [AGENT_RUNTIME_STARTUP_PROBE_ENV]: "1",
    });
    let startupDisabled = false;
    const launchInstalled = async (startup = false): Promise<void> => {
      recordPhase("startup");
      application = await _electron.launch({
        executablePath: executable,
        args: [
          `--user-data-dir=${join(root, "electron-user-data")}`,
          ...(startup ? [WINDOWS_STARTUP_ARGUMENT] : []),
        ],
        timeout: 60_000,
        cwd: root,
        env: installedEnvironment(),
      });
      child = application.process();
      // Playwright wraps Electron in cmd.exe on Windows; claims identify Main.
      const hostPid = await application.evaluate(() => process.pid);
      const shortcutAppId = await application.evaluate(
        ({ shell }, path) => shell.readShortcutLink(path).appUserModelId,
        startMenuShortcut,
      );
      if (shortcutAppId !== "app.jyu.nodex")
        throw new Error(`Unexpected Start menu shortcut AppUserModelID: ${shortcutAppId}`);
      const loginStatus = await application.evaluate(
        ({ app }, argument) =>
          app.getLoginItemSettings({ path: process.execPath, args: [argument] }),
        WINDOWS_STARTUP_ARGUMENT,
      );
      writeFileSync(
        join(artifacts, `startup-status-${startupDisabled ? "disabled" : "enabled"}.json`),
        `${JSON.stringify(loginStatus, null, 2)}\n`,
      );
      if (windowsLoginItemEnabled(executable, loginStatus) === startupDisabled)
        throw new Error("Installed Electron startup status differs from Windows approval");
      const sdkLoaded = await application.evaluate(
        (_electron, url) => {
          // Debugger evaluations have no ESM import callback; Node's loader uses the same file.
          const require = process.getBuiltinModule("node:module").createRequire(url);
          const sdk = require(
            process.getBuiltinModule("node:url").fileURLToPath(url),
          ) as typeof import("@anthropic-ai/claude-agent-sdk");
          return typeof sdk.query === "function" && typeof sdk.listSessions === "function";
        },
        claudeSdkModuleUrl({
          isPackaged: true,
          resourcesPath: join(installRoot, "resources"),
          projectRootPath: root,
        }),
      );
      if (!sdkLoaded) throw new Error("Installed Main could not load the shared Claude SDK");
      desktopPid = hostPid;
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
            claude: { version: claudeVersion, sharedSdkLoaded: sdkLoaded },
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
    const quitNormally = async (): Promise<void> => {
      if (!application || desktopPid === undefined) throw new Error("Installed desktop is missing");
      const { descriptor } = readCoreRuntimeConnection(profile);
      const quitTimeoutMs = 15_000;
      const quitStarted = Date.now();
      // Playwright requests app.quit() and detaches its debugger, but waits for
      // cmd.exe's stream closure too. Observe the exact Main and Core PIDs.
      const close = application.close();
      desktopCloses.push(close);
      void close.catch(() => undefined);
      // The Core drain has its own budget inside Main's shutdown sequence.
      // From the quit request, both processes share the end-to-end deadline.
      const [coreExitMs] = await Promise.all([
        waitForProcessStopped(descriptor.pid, quitTimeoutMs).then(() => Date.now() - quitStarted),
        waitForProcessStopped(desktopPid, quitTimeoutMs),
      ]);
      normalQuitEvidence = {
        completed: true,
        hostPid: desktopPid,
        corePid: descriptor.pid,
        coreExitMs,
        elapsedMs: Date.now() - quitStarted,
      };
    };
    const forceDesktopLeavingCore = async (): Promise<number> => {
      if (!application || desktopPid === undefined) throw new Error("Installed desktop is missing");
      const { descriptor } = readCoreRuntimeConnection(profile);
      // Kill only Main, as Stop-Process -Force would. Tree termination would
      // hide the maintenance case by killing detached Core before the installer.
      process.kill(desktopPid, "SIGKILL");
      await waitForProcessStopped(desktopPid, 5_000);
      const client = await CoreClient.connect({
        nodexHome: profile,
        clientKind: "native_cli",
        buildId: "windows-installer-detached-core-probe",
        requestTimeoutMs: 5_000,
      });
      await client.health();
      if (client.handshake.generation.start_nonce !== descriptor.start_nonce)
        throw new Error("Force-killing Desktop replaced the selected Core generation");
      process.kill(descriptor.pid, 0);
      return descriptor.pid;
    };
    const renewHostClaim = (): void => {
      // Each launch needs a fresh host claim, while retaining the same Profile.
      lease.release();
      runId = randomUUID();
      lease = acquireIsolatedRunLease({ nodexHome: profile, runId, supervisorPid: process.pid });
      rmSync(join(profile, "run", AGENT_RUNTIME_STARTUP_EVIDENCE_FILE), { force: true });
    };
    await launchInstalled(true);
    if (!application) throw new Error("Background Desktop is missing");
    const backgroundWindows = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    );
    if (
      backgroundWindows.length !== 1 ||
      backgroundWindows.some((window) => window.visible || window.focused)
    )
      throw new Error("Startup activation displayed or focused an application window");
    const retainedWindowId = backgroundWindows[0]!.id;
    const coreBeforeHide = readCoreRuntimeConnection(profile).descriptor.pid;
    await application.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id);
      window?.show();
      window?.close();
    }, retainedWindowId);
    await delay(2_000);
    const retained = await application.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id);
      return window ? { visible: window.isVisible(), destroyed: window.isDestroyed() } : null;
    }, retainedWindowId);
    if (
      !retained ||
      retained.visible ||
      retained.destroyed ||
      readCoreRuntimeConnection(profile).descriptor.pid !== coreBeforeHide ||
      !isProcessRunning(coreBeforeHide)
    )
      throw new Error("Closing the last tray window retired Desktop, its renderer or Core");
    writeFileSync(
      join(artifacts, "tray-lifecycle.json"),
      JSON.stringify({ backgroundWindows, retained, corePid: coreBeforeHide }, null, 2),
    );
    await quitNormally();
    renewHostClaim();
    await launchInstalled();
    const oldCorePid = await forceDesktopLeavingCore();
    execFileSync("reg.exe", [
      "add",
      startupApprovedKey,
      "/v",
      WINDOWS_LOGIN_ITEM_NAME,
      "/t",
      "REG_BINARY",
      "/d",
      "030000000000000000000000",
      "/f",
    ]);
    const disabledApproval = queryStartupValue(startupApprovedKey);
    startupDisabled = true;
    recordPhase("upgrade");
    const upgradeStarted = Date.now();
    rmSync(maintenanceLog, { force: true });
    await runMaintenance(resolve("dist", installers[0]!), ["/S", "/currentuser"], {
      timeout: installerTimeoutMs,
    });
    captureMaintenanceLog("upgrade");
    assertProcessStopped(oldCorePid);
    if (!isProfilePreserved()) throw new Error("Upgrade removed Profile content");
    if (
      queryStartupValue(startupRunKey) !== loginRegistration ||
      queryStartupValue(startupApprovedKey) !== disabledApproval
    )
      throw new Error("Upgrade changed login registration or re-enabled disabled startup");
    upgradeEvidence = {
      completed: true,
      elapsedMs: Date.now() - upgradeStarted,
      oldCorePid,
      desktopExit: "forced",
      profilePreserved: true,
    };
    renewHostClaim();
    await launchInstalled();
    // Exercise the exact updater command over a running per-user installation.
    // A fresh supervisor claim lets NSIS's relaunch prove a new host generation.
    const beforeUpdate = readCoreRuntimeConnection(profile).descriptor;
    const oldProcesses = installationProcesses(installRoot);
    renewHostClaim();
    const command = windowsUpdateInstallerCommand(resolve("dist", installers[0]!), true);
    recordPhase("update");
    const updateStarted = Date.now();
    rmSync(maintenanceLog, { force: true });
    const updaterInstaller = spawn(command.executable, command.args, {
      ...command.options,
      env: installedEnvironment(),
    });
    const [installerExitCode] = await once(updaterInstaller, "exit", {
      signal: AbortSignal.timeout(installerTimeoutMs),
    });
    captureMaintenanceLog("update");
    if (installerExitCode !== 0)
      throw new Error(`Silent update installer failed (${installerExitCode})`);
    const updateDeadline = Date.now() + 60_000;
    while (true) {
      const claim = readIsolatedRunClaim(profile);
      const agentFile = join(profile, "run", AGENT_RUNTIME_STARTUP_EVIDENCE_FILE);
      if (claim?.phase === "ready" && claim.runId === runId && existsSync(agentFile)) {
        const agent = parseAgentRuntimeStartupEvidence(
          JSON.parse(readFileSync(agentFile, "utf8")),
          { runId, hostPid: claim.hostPid },
        );
        if (agent) {
          const afterUpdate = readCoreRuntimeConnection(profile).descriptor;
          const client = await CoreClient.connect({
            nodexHome: profile,
            clientKind: "native_cli",
            buildId: "windows-update-handoff-probe",
            requestTimeoutMs: 10_000,
          });
          await client.health();
          if (
            afterUpdate.profile_id !== beforeUpdate.profile_id ||
            afterUpdate.artifact.sha256 !== expectedCoreSha256 ||
            client.handshake.generation.profile_id !== beforeUpdate.profile_id
          )
            throw new Error("Update changed the Profile or Core artifact identity");
          if (afterUpdate.start_nonce === beforeUpdate.start_nonce)
            throw new Error("Update did not restart Core");
          const processes = installationProcesses(installRoot);
          if (
            oldProcesses.some((previous) =>
              processes.some(
                (current) =>
                  current.pid === previous.pid && current.createdAt === previous.createdAt,
              ),
            )
          ) {
            throw new Error("Silent update left an old installation process running");
          }
          const hosts = processes.filter(
            (process) =>
              /Nodex\.exe/i.test(process.commandLine) &&
              !/--type=|--crashpad-handler/i.test(process.commandLine),
          );
          if (hosts.length !== 1 || hosts[0]!.pid !== claim.hostPid)
            throw new Error("Update did not relaunch exactly one installed Desktop");
          if (!isProfilePreserved() || queryProtocol() !== registration)
            throw new Error("Update changed Profile content or protocol registration");
          desktopPid = claim.hostPid;
          updateHandoffEvidence = {
            completed: true,
            args: command.args,
            elapsedMs: Date.now() - updateStarted,
            oldProcessPids: oldProcesses.map((process) => process.pid),
            hostPid: claim.hostPid,
            corePid: afterUpdate.pid,
            profileId: afterUpdate.profile_id,
            coreSha256: afterUpdate.artifact.sha256,
            profilePreserved: true,
            installedHostCount: hosts.length,
            agent,
          };
          break;
        }
      }
      if (Date.now() >= updateDeadline)
        throw new Error(
          "Silent update did not relaunch the installed app with Core and Agent readiness",
        );
      await delay(100);
    }
    detachedCoreBeforeUninstall = await forceDesktopLeavingCore();
  } catch (error) {
    failures.push(new Error(`${failureDetails(error)}\n${captureMaintenanceLog("failed")}`));
  } finally {
    await cleanup();
  }
  recordPhase("finished");
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
