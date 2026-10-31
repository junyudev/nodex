import path from "node:path";
import {
  initializeStandaloneDataAuthority,
  type RustDataAuthorityRuntime,
} from "../../../src/main/core-client";
import { CoreClientSeedAdapter } from "../adapters/core-client-seed-adapter";
import type { ScenarioManifest } from "../contracts";
import { waitForCoreRuntimeRemoval } from "../profile/isolated-profile";
import { materializeScenario } from "../seed/scenario-seed";
import { materializeSeededSourceFolder } from "../seed/source-folder";
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
  if (!manifest) throw new Error(`Seed ${input.scenarioId} produced no manifest`);
  if (input.scenarioId === CROSS_PROVIDER_SCENARIO_ID) {
    const { prepareCrossProviderDelegationRuntime } =
      await import("../runtime/cross-provider-delegation");
    prepareCrossProviderDelegationRuntime({
      nodexHome: input.nodexHome,
      manifest,
      clock: input.runtimeClock,
    });
  }
  return manifest;
};
