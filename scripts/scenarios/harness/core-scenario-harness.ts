import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  initializeStandaloneDataAuthority,
  type DesktopCoreClient,
  type RustDataAuthorityRuntime,
} from "../../../src/main/core-client";
import type { CoreStartupEvent } from "../../../src/main/core-client/core-launcher";
import type { IsolatedProfile } from "../profile/isolated-profile";
import {
  cleanupIsolatedProfile,
  createIsolatedProfile,
  waitForCoreRuntimeRemoval,
} from "../profile/isolated-profile";
import type { ScenarioFacts, ScenarioManifest } from "../contracts";
import { CoreClientSeedAdapter } from "../adapters/core-client-seed-adapter";
import { inspectScenario, materializeScenario } from "../seed/scenario-seed";
import { getScenario } from "../registry";

export interface CoreScenarioProgress {
  readonly phase:
    | "create-profile"
    | "startup"
    | "seed"
    | "inspect"
    | "run"
    | "shutdown"
    | "runtime-removal"
    | "cleanup";
  readonly elapsedMs: number;
  readonly nodexHome?: string;
  readonly startupEvent?: CoreStartupEvent;
}

export interface CoreScenarioInput {
  readonly scenarioId: string;
  /** Cancels the launcher and handshake; individual Core operations retain their own deadlines. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CoreScenarioProgress) => void;
}

export interface CoreScenarioContext {
  readonly client: DesktopCoreClient;
  readonly runtime: RustDataAuthorityRuntime;
  readonly profile: IsolatedProfile;
  readonly manifest: ScenarioManifest;
  readonly facts: ScenarioFacts;
  readonly seed: CoreClientSeedAdapter;
  /** Runs a cold-start assertion, then reattaches the harness to the current Core generation. */
  readonly withStoppedCore: <Value>(run: () => Promise<Value>) => Promise<Value>;
}

export const readCoreScenarioDiagnostics = async (nodexHome: string): Promise<string> => {
  const logDirectory = path.join(nodexHome, "logs");
  try {
    const entries = (await readdir(logDirectory))
      .filter((entry) => entry.endsWith(".log"))
      .sort()
      .slice(-2);
    const logs = await Promise.all(
      entries.map(
        async (entry) =>
          `== ${entry} ==\n${await readFile(path.join(logDirectory, entry), "utf8")}`,
      ),
    );
    return logs.join("\n").slice(-8_192);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "No Core logs were written.";
    }
    return `Could not read Core logs: ${error instanceof Error ? error.message : String(error)}`;
  }
};

export const withCoreScenario = async <Value>(
  input: CoreScenarioInput,
  run: (context: CoreScenarioContext) => Promise<Value>,
): Promise<Value> => {
  input.signal?.throwIfAborted();
  const startedAt = performance.now();
  const progress = (
    phase: CoreScenarioProgress["phase"],
    nodexHome?: string,
    startupEvent?: CoreStartupEvent,
  ) => {
    try {
      input.onProgress?.({
        phase,
        elapsedMs: performance.now() - startedAt,
        nodexHome,
        startupEvent,
      });
    } catch {
      // Diagnostic observers must never change scenario operations or skip owned cleanup.
    }
  };
  const recipe = getScenario(input.scenarioId);
  progress("create-profile");
  const profile = await createIsolatedProfile({
    label: input.scenarioId,
    codex: "empty",
    retention: "dispose",
  });
  let runtime: RustDataAuthorityRuntime | null = null;
  let completed = false;
  let value: Value | undefined;
  let operationError: unknown;
  try {
    input.signal?.throwIfAborted();
    progress("startup", profile.nodexHome);
    runtime = await initializeStandaloneDataAuthority({
      buildId: `scenario:${input.scenarioId}`,
      isPackaged: false,
      nodexHome: profile.nodexHome,
      signal: input.signal,
      onStartupEvent: (event) => progress("startup", profile.nodexHome, event),
    });
    let seed = new CoreClientSeedAdapter(runtime);
    const currentRuntime = () => {
      if (!runtime) throw new Error("Scenario Core is unavailable");
      return runtime;
    };
    input.signal?.throwIfAborted();
    progress("seed", profile.nodexHome);
    const manifest = await materializeScenario(
      input.scenarioId,
      seed,
      profile.initialProjectsDirectory,
    );
    input.signal?.throwIfAborted();
    progress("inspect", profile.nodexHome);
    const facts = await inspectScenario(manifest, seed);
    input.signal?.throwIfAborted();
    progress("run", profile.nodexHome);
    value = await run({
      get client() {
        return currentRuntime().rootClient;
      },
      get runtime() {
        return currentRuntime();
      },
      profile,
      manifest,
      facts,
      get seed() {
        return seed;
      },
      withStoppedCore: async (run) => {
        if (!runtime) throw new Error("Scenario Core is unavailable");
        progress("shutdown", profile.nodexHome);
        await runtime.rootClient.shutdown();
        progress("runtime-removal", profile.nodexHome);
        await waitForCoreRuntimeRemoval(profile.nodexHome);
        try {
          return await run();
        } finally {
          input.signal?.throwIfAborted();
          progress("startup", profile.nodexHome);
          runtime = await initializeStandaloneDataAuthority({
            buildId: `scenario:${input.scenarioId}`,
            isPackaged: false,
            nodexHome: profile.nodexHome,
            signal: input.signal,
            onStartupEvent: (event) => progress("startup", profile.nodexHome, event),
          });
          seed = new CoreClientSeedAdapter(runtime);
          progress("run", profile.nodexHome);
        }
      },
    });
    input.signal?.throwIfAborted();
    completed = true;
  } catch (error) {
    const diagnostics = await readCoreScenarioDiagnostics(profile.nodexHome);
    operationError = new Error(
      `Core scenario ${input.scenarioId}@${recipe.revision} failed in ${profile.runRoot}: ${error instanceof Error ? error.message : String(error)}\n${diagnostics}`,
      { cause: error },
    );
  }
  const teardownErrors: unknown[] = [];
  if (runtime) {
    try {
      progress("shutdown", profile.nodexHome);
      await runtime.rootClient.shutdown();
      progress("runtime-removal", profile.nodexHome);
      await waitForCoreRuntimeRemoval(profile.nodexHome);
    } catch (error) {
      teardownErrors.push(error);
    }
  }
  try {
    progress("cleanup", profile.nodexHome);
    const cleanup = await cleanupIsolatedProfile(profile);
    if (cleanup.status === "unsafe") {
      teardownErrors.push(
        new Error(`Preserved Core scenario Profile ${profile.runRoot}: ${cleanup.reason}`),
      );
    }
  } catch (error) {
    teardownErrors.push(error);
  }
  if (operationError && teardownErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...teardownErrors],
      `Core scenario ${input.scenarioId} and teardown both failed`,
    );
  }
  if (operationError) throw operationError;
  if (teardownErrors.length > 0) {
    throw new AggregateError(
      teardownErrors,
      `Core scenario ${input.scenarioId} teardown failed in ${profile.runRoot}`,
    );
  }
  if (!completed) throw new Error("Core scenario ended without a result");
  return value as Value;
};
