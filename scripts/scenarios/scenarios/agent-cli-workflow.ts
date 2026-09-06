import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const AGENT_CLI_SCENARIO_ID = "agent/cli-workflow" as const;
export const AGENT_CLI_PROJECT_NAME = "Agent CLI Lab";
export const AGENT_CLI_PAGE_KEY = "meeting";
export const AGENT_CLI_PAGE_TITLE = "Release meeting";

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: AGENT_CLI_PROJECT_NAME, sources: [workspace] });
  if (!project.defaultDatabaseViewId) throw new Error("CLI scenario needs its saved Board");
  const pageId = createUuidV7();
  await port.createPage({
    key: AGENT_CLI_PAGE_KEY,
    pageId,
    operationId: createUuidV7(),
    projectId: project.id,
    status: "build",
    title: AGENT_CLI_PAGE_TITLE,
    nfm: "# Release meeting\n\nRelease date: Friday.\n\nKeep the rollback checklist intact.",
  });
  const page = await port.readPage(project.id, pageId);
  return {
    version: 1,
    scenarioId: AGENT_CLI_SCENARIO_ID,
    scenarioRevision: 1,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: { [AGENT_CLI_PAGE_KEY]: pageId },
    minimumCommitSeq: page.commitSeq,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<ScenarioFacts> => {
  const pageId = manifest.pageIdsByKey[AGENT_CLI_PAGE_KEY];
  if (!pageId) throw new Error("CLI scenario Page is missing");
  const page = await port.readPage(manifest.projectId, pageId);
  if (page.title !== AGENT_CLI_PAGE_TITLE || page.documentReadiness !== "ready") {
    throw new Error("CLI scenario Page was not materialized through public operations");
  }
  return { scenarioId: AGENT_CLI_SCENARIO_ID, scenarioRevision: 1 };
};

export const agentCliWorkflowScenario: ScenarioDomainRecipe = {
  id: AGENT_CLI_SCENARIO_ID,
  revision: 1,
  materialize,
  inspect,
  parseFacts: (value) => {
    const facts = parseScenarioFacts(value);
    if (facts.scenarioId !== AGENT_CLI_SCENARIO_ID || facts.scenarioRevision !== 1) {
      throw new Error("CLI scenario facts have an unexpected identity");
    }
    return facts;
  },
};
