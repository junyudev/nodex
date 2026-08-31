import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import {
  acquireIsolatedRunLease,
  type IsolatedRunLease,
} from "../../../src/main/core-client/isolated-run-ownership";
import {
  developmentFeatureEnvironment,
  resolveDevelopmentFeatureOverrides,
} from "../../../src/shared/development-features";
import { cleanupIsolatedCore } from "../../isolated-core-cleanup";
import type { ScenarioFacts, ScenarioManifest, ScenarioSeedPort } from "../contracts";
import { RendererIpcSeedAdapter } from "../adapters/renderer-ipc-seed-adapter";
import type {
  IsolatedCodexPolicy,
  IsolatedProfile,
  IsolatedProfileRetention,
} from "../profile/isolated-profile";
import { cleanupIsolatedProfile, createIsolatedProfile } from "../profile/isolated-profile";
import { getScenario } from "../registry";
import { prepareScenarioAgentRuntime } from "../runtime/agent-runtime-fixture";
import { inspectScenario, materializeScenario } from "../seed/scenario-seed";

const repositoryRoot = process.cwd();
const DEFAULT_RUNTIME_LOG_CHARS = 32_768;
const APPLICATION_WINDOW_DISCOVERY_TIMEOUT_MS = 60_000;

const delay = async (durationMs: number): Promise<void> =>
  await new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));

/** Resolves the canonical Nodex renderer once its final preload is available. */
export async function waitForNodexApplicationWindow(
  application: ElectronApplication,
): Promise<Page> {
  const deadline = Date.now() + APPLICATION_WINDOW_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      const hasApplicationApi = await page
        .evaluate(() =>
          Boolean(
            (
              window as unknown as {
                api?: unknown;
              }
            ).api,
          ),
        )
        .catch(() => false);
      if (hasApplicationApi) return page;
    }
    await delay(25);
  }
  throw new Error("Nodex did not create a full application window before the startup deadline");
}

/** Resolves the first physical application window without waiting for Main initialization. */
export async function waitForNodexFirstWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + APPLICATION_WINDOW_DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const page = application.windows()[0];
    if (page) return page;
    await delay(25);
  }
  throw new Error("Nodex did not create its canonical window before the startup deadline");
}

export const readBoundedElectronRuntimeLogs = async (
  profile: IsolatedProfile,
  maximumCharacters = DEFAULT_RUNTIME_LOG_CHARS,
): Promise<string> => {
  const logDirectory = path.join(profile.nodexHome, "logs");
  let entries: string[];
  try {
    entries = (await readdir(logDirectory))
      .filter((entry) => entry.endsWith(".log"))
      .sort()
      .slice(-4);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "No runtime logs were written.\n";
    }
    throw error;
  }
  const sections = await Promise.all(
    entries.map(
      async (entry) => `== ${entry} ==\n${await readFile(path.join(logDirectory, entry), "utf8")}`,
    ),
  );
  return `${sections.join("\n").slice(-maximumCharacters)}\n`;
};

export interface NodexElectronLaunchInput {
  readonly codexHome?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly executablePath?: string;
  readonly initialProjectsDirectory: string;
  readonly nodexHome: string;
  readonly runId?: string;
}

export async function launchNodexElectronApplication(
  input: NodexElectronLaunchInput,
): Promise<ElectronApplication> {
  return await electron.launch({
    ...(input.executablePath
      ? { executablePath: input.executablePath }
      : { args: [repositoryRoot] }),
    cwd: input.cwd ?? repositoryRoot,
    env: {
      ...process.env,
      ...input.environment,
      ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
      NODEX_HOME: input.nodexHome,
      NODEX_INITIAL_PROJECTS_DIR: input.initialProjectsDirectory,
      ...(input.runId ? { NODEX_INTERNAL_ISOLATED_RUN_ID: input.runId } : {}),
      NODE_ENV: "test",
    },
  });
}

const waitForApplicationExit = async (
  child: ReturnType<ElectronApplication["process"]>,
  timeoutMs: number,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Electron process exit exceeded its teardown deadline"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
};

const forceStopApplicationProcess = (child: ReturnType<ElectronApplication["process"]>): void => {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
      return;
    }
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited concurrently.
    }
  }
};

export const stopNodexElectronApplication = async (
  application: ElectronApplication,
): Promise<void> => {
  let child: ReturnType<ElectronApplication["process"]>;
  try {
    child = application.process();
  } catch {
    // A normal app.quit() may close Playwright's Main connection before teardown observes it.
    return;
  }
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await application.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0);
      return true;
    });
    await waitForApplicationExit(child, 20_000);
    return;
  } catch {
    // Fall through when the Main transport is already unavailable.
  }
  try {
    await Promise.race([
      application.close().catch(() => undefined),
      new Promise<never>((_, reject) => {
        closeTimer = setTimeout(
          () => reject(new Error("Electron close exceeded its teardown deadline")),
          15_000,
        );
      }),
    ]);
    await waitForApplicationExit(child, 10_000);
  } catch {
    forceStopApplicationProcess(child);
    await waitForApplicationExit(child, 5_000).catch(() => undefined);
  } finally {
    clearTimeout(closeTimer);
  }
};

export interface ElectronHarnessInput {
  readonly label: string;
  readonly codex?: IsolatedCodexPolicy;
  readonly retention?: IsolatedProfileRetention;
  readonly sourceCodexHome?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly executablePath?: string;
  readonly enabledFeatures?: readonly string[];
  readonly prepareAgentRuntime?: boolean;
}

export class ElectronScenarioHarness {
  readonly profile: IsolatedProfile;
  readonly #cwd: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executablePath: string | undefined;
  readonly #lease: IsolatedRunLease;
  #application: ElectronApplication | null = null;
  #page: Page | null = null;
  #closing: Promise<void> | null = null;

  private constructor(
    profile: IsolatedProfile,
    cwd: string,
    environment: NodeJS.ProcessEnv,
    lease: IsolatedRunLease,
    executablePath?: string,
  ) {
    this.profile = profile;
    this.#cwd = cwd;
    this.#environment = environment;
    this.#executablePath = executablePath;
    this.#lease = lease;
  }

  static async create(input: ElectronHarnessInput): Promise<ElectronScenarioHarness> {
    const profile = await createIsolatedProfile({
      label: input.label,
      codex: input.codex ?? "empty",
      retention: input.retention ?? "dispose",
      sourceCodexHome: input.sourceCodexHome,
    });
    try {
      const cwd = input.cwd ?? profile.runRoot;
      if (input.prepareAgentRuntime !== false && cwd === profile.runRoot) {
        await prepareScenarioAgentRuntime(cwd);
      }
      const lease = acquireIsolatedRunLease({
        nodexHome: profile.nodexHome,
        runId: profile.runId,
        supervisorPid: process.pid,
      });
      return new ElectronScenarioHarness(
        profile,
        cwd,
        {
          ...(input.prepareAgentRuntime !== false && cwd === profile.runRoot
            ? { NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: "." }
            : {}),
          ...input.environment,
          ...developmentFeatureEnvironment(
            resolveDevelopmentFeatureOverrides(input.enabledFeatures ?? []),
          ),
        },
        lease,
        input.executablePath,
      );
    } catch (error) {
      const cleanup = await cleanupIsolatedProfile({
        ...profile,
        retention: "dispose",
      });
      if (cleanup.status === "unsafe") {
        // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains the primary failure and cleanup failure explicitly.
        throw new AggregateError(
          [error, new Error(cleanup.reason)],
          `Failed to initialize and clean Electron scenario ${profile.runRoot}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  get application(): ElectronApplication {
    if (!this.#application) throw new Error("Electron scenario is not running");
    return this.#application;
  }

  get page(): Page {
    if (!this.#page) throw new Error("Electron scenario renderer is not running");
    return this.#page;
  }

  async launch(options?: { readonly phase?: "application-ready" | "first-window" }): Promise<Page> {
    if (this.#application) throw new Error("Electron scenario is already running");
    const application = await launchNodexElectronApplication({
      cwd: this.#cwd,
      codexHome: this.profile.codexHome,
      nodexHome: this.profile.nodexHome,
      initialProjectsDirectory: this.profile.initialProjectsDirectory,
      runId: this.profile.runId,
      environment: this.#environment,
      executablePath: this.#executablePath,
    });
    this.#application = application;
    const page =
      options?.phase === "first-window"
        ? await waitForNodexFirstWindow(application)
        : await waitForNodexApplicationWindow(application);
    this.#page = page;
    if (options?.phase === "first-window") return page;
    await this.waitForApplicationReady();
    return page;
  }

  async waitForApplicationReady(): Promise<Page> {
    const page = this.#page;
    if (!page) throw new Error("Electron scenario renderer is not running");
    await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api?: { awaitInitialization(): Promise<void> };
        }
      ).api;
      if (!api) throw new Error("Nodex preload API is unavailable");
      await api.awaitInitialization();
    });
    return page;
  }

  async restart(): Promise<Page> {
    await this.stopElectron();
    return await this.launch();
  }

  async stopElectron(): Promise<void> {
    const application = this.#application;
    if (!application) return;
    this.#application = null;
    this.#page = null;
    await stopNodexElectronApplication(application);
  }

  /** Stops the exact owned Core while retaining the lease for an offline fixture mutation. */
  async stopCoreForOfflineFixture(): Promise<void> {
    await this.stopElectron();
    const cleanup = await cleanupIsolatedCore({
      lease: this.#lease,
      nodexHome: this.profile.nodexHome,
      releaseLeaseOnSuccess: false,
      runId: this.profile.runId,
    });
    if (cleanup.safeToDeleteRunRoot) return;
    throw new Error(
      `Could not stop the owned Core for offline fixture work: ${cleanup.reason ?? cleanup.status}`,
    );
  }

  async close(): Promise<void> {
    this.#closing ??= this.#close();
    return await this.#closing;
  }

  async #close(): Promise<void> {
    const teardownErrors: unknown[] = [];
    try {
      await this.stopElectron();
    } catch (error) {
      teardownErrors.push(error);
    }
    const cleanup = await cleanupIsolatedCore({
      lease: this.#lease,
      nodexHome: this.profile.nodexHome,
      runId: this.profile.runId,
    });
    if (!cleanup.safeToDeleteRunRoot) {
      teardownErrors.push(
        new Error(
          `Preserved Electron scenario Profile ${this.profile.runRoot}: ${cleanup.reason ?? cleanup.status}`,
        ),
      );
    }
    if (teardownErrors.length === 0) {
      const profileCleanup = await cleanupIsolatedProfile(this.profile);
      if (profileCleanup.status === "unsafe") {
        teardownErrors.push(
          new Error(
            `Preserved Electron scenario Profile ${this.profile.runRoot}: ${profileCleanup.reason}`,
          ),
        );
      }
    }
    if (teardownErrors.length > 0) {
      throw new AggregateError(
        teardownErrors,
        `Electron scenario teardown failed in ${this.profile.runRoot}`,
      );
    }
  }
}

export interface ElectronScenarioContext {
  readonly harness: ElectronScenarioHarness;
  readonly application: ElectronApplication;
  readonly page: Page;
  readonly profile: IsolatedProfile;
  readonly seed: ScenarioSeedPort;
  readonly manifest: ScenarioManifest | null;
  readonly facts: ScenarioFacts | null;
  readonly readRuntimeLogs: () => Promise<string>;
}

export interface ElectronScenarioFailureContext {
  readonly facts: ScenarioFacts | null;
  readonly manifest: ScenarioManifest | null;
  readonly page: Page | null;
  readonly profile: IsolatedProfile;
  readonly readRuntimeLogs: () => Promise<string>;
}

export interface ElectronScenarioInput extends ElectronHarnessInput {
  readonly scenarioId: string | null;
  readonly onFailure?: (context: ElectronScenarioFailureContext) => Promise<void>;
}

export const withElectronScenario = async <Value>(
  input: ElectronScenarioInput,
  run: (context: ElectronScenarioContext) => Promise<Value>,
): Promise<Value> => {
  const scenarioLabel = input.scenarioId
    ? `${input.scenarioId}@${getScenario(input.scenarioId).revision}`
    : "unseeded";
  const harness = await ElectronScenarioHarness.create(input);
  let completed = false;
  let value: Value | undefined;
  let operationError: unknown;
  let page: Page | null = null;
  let manifest: ScenarioManifest | null = null;
  let facts: ScenarioFacts | null = null;
  const readRuntimeLogs = () => readBoundedElectronRuntimeLogs(harness.profile);
  try {
    page = await harness.launch();
    const seed = new RendererIpcSeedAdapter(page);
    manifest = input.scenarioId
      ? await materializeScenario(input.scenarioId, seed, harness.profile.initialProjectsDirectory)
      : null;
    facts = manifest ? await inspectScenario(manifest, seed) : null;
    value = await run({
      harness,
      application: harness.application,
      page,
      profile: harness.profile,
      seed,
      manifest,
      facts,
      readRuntimeLogs,
    });
    completed = true;
  } catch (error) {
    const socket = path.join(harness.profile.nodexHome, "run/core/core.sock");
    const diagnostic = existsSync(socket) ? "Core socket present" : "Core socket absent";
    const scenarioError = new Error(
      `Electron scenario ${scenarioLabel} failed in ${harness.profile.runRoot} (${diagnostic}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
    try {
      await input.onFailure?.({
        facts,
        manifest,
        page,
        profile: harness.profile,
        readRuntimeLogs,
      });
      operationError = scenarioError;
    } catch (artifactError) {
      operationError = new AggregateError(
        [scenarioError, artifactError],
        `Electron scenario ${scenarioLabel} and failure capture both failed`,
      );
    }
  }
  let cleanupError: unknown;
  try {
    await harness.close();
  } catch (error) {
    cleanupError = error;
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      `Electron scenario ${scenarioLabel} and teardown both failed`,
    );
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  if (!completed) throw new Error("Electron scenario ended without a result");
  return value as Value;
};
