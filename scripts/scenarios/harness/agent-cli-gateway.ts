/* @effect-diagnostics asyncFunction:off -- Uses the isolated Core scenario's Promise boundary. */
import { openScopedAgentCore } from "../../../src/main/platform/node/ScopedAgentCoreServer";
import {
  withCoreScenario,
  type CoreScenarioContext,
  type CoreScenarioInput,
} from "./core-scenario-harness";

export const withAgentCliScenario = <A>(
  input: CoreScenarioInput,
  run: (
    scenario: CoreScenarioContext,
    issue: (
      owner: string,
      projectId?: string,
    ) => ReturnType<Awaited<ReturnType<typeof openScopedAgentCore>>["issue"]>,
  ) => Promise<A>,
): Promise<A> =>
  withCoreScenario(input, async (scenario) => {
    const { sessionId } = await scenario.seed.createRelatedChat({
      projectId: scenario.manifest.projectId,
      noThreadFallbackTitle: "Agent CLI fixture",
      relatedPageIds: [],
    });
    const server = await openScopedAgentCore(scenario.profile.nodexHome);
    try {
      return await run(scenario, (owner, projectId = scenario.manifest.projectId) =>
        server.issue({
          owner,
          projectId,
          attribution: { session_id: sessionId, run_id: `fixture:${owner}`, backend: "codex" },
          identity: scenario.runtime.identity,
          authorize: async () => "allowed",
        }),
      );
    } finally {
      await server.close();
    }
  });
