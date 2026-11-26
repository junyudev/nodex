import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  initializeStandaloneDataAuthority,
  type RustDataAuthorityRuntime,
} from "../../../src/main/core-client";
import { CoreClientSeedAdapter, profileHasWork } from "../adapters/core-client-seed-adapter";
import type { ScenarioManifest } from "../contracts";
import { waitForCoreRuntimeRemoval } from "../profile/isolated-profile";
import { materializeScenario } from "../seed/scenario-seed";
import { materializeSeededSourceFolder } from "../seed/source-folder";
import { RELEASE_CAPTURE_SCENARIO_ID } from "../scenarios/nodex-coordination";
import { CROSS_PROVIDER_SCENARIO_ID } from "../scenarios/agent-cross-provider-delegation";

export const materializeDevelopmentSeed = async (input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly scenarioId: string;
  readonly nodexHome: string;
  readonly runtimeClock?: "manual" | "realtime";
}): Promise<ScenarioManifest> => {
  let runtime: RustDataAuthorityRuntime | null = null;
  let manifest: ScenarioManifest | null = null;
  let operationError: unknown;
  try {
    const workspace = await materializeSeededSourceFolder(
      path.dirname(input.nodexHome),
      input.scenarioId,
    );
    runtime = await initializeStandaloneDataAuthority({
      buildId: `dev-seed:${input.scenarioId}`,
      environment: input.environment,
      isPackaged: false,
      nodexHome: input.nodexHome,
    });
    manifest = await materializeScenario(
      input.scenarioId,
      new CoreClientSeedAdapter(runtime),
      workspace,
    );
  } catch (error) {
    operationError = error;
  }

  const teardownErrors: unknown[] = [];
  if (runtime) {
    try {
      await runtime.rootClient.shutdown();
      await waitForCoreRuntimeRemoval(input.nodexHome);
    } catch (error) {
      teardownErrors.push(error);
    }
  }
  if (operationError && teardownErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...teardownErrors],
      `Seed ${input.scenarioId} and Core teardown both failed`,
    );
  }
  if (operationError) throw operationError;
  if (teardownErrors.length > 0) {
    throw new AggregateError(teardownErrors, `Seed ${input.scenarioId} Core teardown failed`);
  }
  if (!manifest || !runtime) throw new Error(`Seed ${input.scenarioId} produced no manifest`);
  if (input.scenarioId === CROSS_PROVIDER_SCENARIO_ID) {
    const { prepareCrossProviderDelegationRuntime } =
      await import("../runtime/cross-provider-delegation");
    await prepareCrossProviderDelegationRuntime({
      nodexHome: input.nodexHome,
      spaceId: runtime.identity.libraryId,
      manifest,
      clock: input.runtimeClock,
    });
  }
  if (input.scenarioId === RELEASE_CAPTURE_SCENARIO_ID) {
    const { prepareScenarioCodexAppServerRuntimeSync } =
      await import("../runtime/agent-runtime-fixture");
    const { seedCoordinationNativeExecution } = await import("../runtime/coordination-native-seed");
    const root = path.join(path.dirname(input.nodexHome), "scripted-agent-runtime");
    prepareScenarioCodexAppServerRuntimeSync(
      root,
      path.resolve("scripts/scenarios/runtime/cross-provider-peer.mjs"),
    );
    await seedCoordinationNativeExecution(root, manifest);
  }
  return manifest;
};

/**
 * Gives a scenario Profile the ordinary Project most tests work in. A Profile that already has
 * work keeps it unchanged, so core-seeded scenarios and restarts add nothing.
 */
export const ensureScenarioProject = async (input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nodexHome: string;
  readonly projectsDirectory: string;
}): Promise<boolean> => {
  const runtime = await initializeStandaloneDataAuthority({
    buildId: "scenario:project",
    environment: input.environment,
    isPackaged: false,
    nodexHome: input.nodexHome,
  });
  try {
    if (await profileHasWork(runtime)) return false;
    const source = path.join(input.projectsDirectory, "My Project");
    await mkdir(source, { recursive: true });
    await new CoreClientSeedAdapter(runtime).createProject({
      name: "My Project",
      sources: [source],
    });
    return true;
  } finally {
    await runtime.rootClient.shutdown();
    await waitForCoreRuntimeRemoval(input.nodexHome);
  }
};
