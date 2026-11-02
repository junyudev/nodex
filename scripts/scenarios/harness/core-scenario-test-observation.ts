import type { TestContext } from "vite-plus/test";
import {
  readCoreScenarioDiagnostics,
  type CoreScenarioInput,
  type CoreScenarioProgress,
} from "./core-scenario-harness";

/** Preserve bounded phase evidence even when Vitest's deadline wins before the scenario unwinds. */
export function observeCoreScenarioTest(
  context: Pick<TestContext, "signal" | "onTestFailed">,
  scenarioId: string,
): CoreScenarioInput {
  const progress: CoreScenarioProgress[] = [];
  context.onTestFailed(async () => {
    console.error(`Core scenario ${scenarioId} phases: ${JSON.stringify(progress)}`);
    const nodexHome = progress.at(-1)?.nodexHome;
    if (nodexHome) console.error(await readCoreScenarioDiagnostics(nodexHome));
  });
  return {
    scenarioId,
    signal: context.signal,
    onProgress: (entry) => {
      progress.push(entry);
      if (progress.length > 24) progress.shift();
    },
  };
}
