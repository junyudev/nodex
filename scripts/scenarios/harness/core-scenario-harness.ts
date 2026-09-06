import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  initializeStandaloneDataAuthority,
  type DesktopCoreClient,
  type RustDataAuthorityRuntime,
} from "../../../src/main/core-client";
import type { IsolatedProfile } from "../profile/isolated-profile";
import { cleanupIsolatedProfile, createIsolatedProfile } from "../profile/isolated-profile";
import type { ScenarioFacts, ScenarioManifest } from "../contracts";
import { CoreClientSeedAdapter } from "../adapters/core-client-seed-adapter";
import { inspectScenario, materializeScenario } from "../seed/scenario-seed";
import { getScenario } from "../registry";

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

const waitForCoreRemoval = async (nodexHome: string): Promise<void> => {
  const socketPath = path.join(nodexHome, "run/core/core.sock");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Core socket remained after shutdown: ${socketPath}`);
};

const readBoundedCoreDiagnostics = async (nodexHome: string): Promise<string> => {
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
  input: { readonly scenarioId: string },
  run: (context: CoreScenarioContext) => Promise<Value>,
): Promise<Value> => {
  const recipe = getScenario(input.scenarioId);
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
    runtime = await initializeStandaloneDataAuthority({
      buildId: `scenario:${input.scenarioId}`,
      isPackaged: false,
      nodexHome: profile.nodexHome,
    });
    let seed = new CoreClientSeedAdapter(runtime);
    const currentRuntime = () => {
      if (!runtime) throw new Error("Scenario Core is unavailable");
      return runtime;
    };
    const manifest = await materializeScenario(
      input.scenarioId,
      seed,
      profile.initialProjectsDirectory,
    );
    const facts = await inspectScenario(manifest, seed);
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
        await runtime.rootClient.shutdown();
        await waitForCoreRemoval(profile.nodexHome);
        try {
          return await run();
        } finally {
          runtime = await initializeStandaloneDataAuthority({
            buildId: `scenario:${input.scenarioId}`,
            isPackaged: false,
            nodexHome: profile.nodexHome,
          });
          seed = new CoreClientSeedAdapter(runtime);
        }
      },
    });
    completed = true;
  } catch (error) {
    const diagnostics = await readBoundedCoreDiagnostics(profile.nodexHome);
    operationError = new Error(
      `Core scenario ${input.scenarioId}@${recipe.revision} failed in ${profile.runRoot}: ${error instanceof Error ? error.message : String(error)}\n${diagnostics}`,
      { cause: error },
    );
  }
  const teardownErrors: unknown[] = [];
  if (runtime) {
    try {
      await runtime.rootClient.shutdown();
      await waitForCoreRemoval(profile.nodexHome);
    } catch (error) {
      teardownErrors.push(error);
    }
  }
  try {
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
