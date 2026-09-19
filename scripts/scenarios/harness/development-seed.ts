import {
  initializeStandaloneDataAuthority,
  type RustDataAuthorityRuntime,
} from "../../../src/main/core-client";
import { CoreClientSeedAdapter } from "../adapters/core-client-seed-adapter";
import type { ScenarioManifest } from "../contracts";
import { waitForCoreRuntimeRemoval } from "../profile/isolated-profile";
import { materializeScenario } from "../seed/scenario-seed";

export const materializeDevelopmentSeed = async (input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly scenarioId: string;
  readonly nodexHome: string;
  readonly workspace: string;
}): Promise<ScenarioManifest> => {
  let runtime: RustDataAuthorityRuntime | null = null;
  let manifest: ScenarioManifest | null = null;
  let operationError: unknown;
  try {
    runtime = await initializeStandaloneDataAuthority({
      buildId: `dev-seed:${input.scenarioId}`,
      environment: input.environment,
      isPackaged: false,
      nodexHome: input.nodexHome,
    });
    manifest = await materializeScenario(
      input.scenarioId,
      new CoreClientSeedAdapter(runtime),
      input.workspace,
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
  return manifest;
};
