import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { parseScenarioFacts, type ScenarioDomainRecipe } from "../contracts";

export const CROSS_PROVIDER_SCENARIO_ID = "agent/cross-provider-delegation";
export const CROSS_PROVIDER_PARENT_TITLE = "Passkey sign-in";
export const CROSS_PROVIDER_RELEASE_TITLE = "Release notes";

export const agentCrossProviderDelegationScenario: ScenarioDomainRecipe = {
  id: CROSS_PROVIDER_SCENARIO_ID,
  revision: 1,
  async materialize(port, workspace) {
    const project = await port.createProject({ name: "lumen-web", sources: [workspace] });
    if (!project.defaultDatabaseViewId) throw new Error("Lumen needs its default View");
    const parent = await port.createRelatedChat({
      projectId: project.id,
      initialPageIds: [],
      noThreadFallbackTitle: CROSS_PROVIDER_PARENT_TITLE,
    });
    const release = await port.createRelatedChat({
      projectId: project.id,
      initialPageIds: [],
      noThreadFallbackTitle: CROSS_PROVIDER_RELEASE_TITLE,
    });
    const pageId = createUuidV7();
    await port.createPage({
      key: "brief",
      pageId,
      operationId: createUuidV7(),
      projectId: project.id,
      status: "build",
      title: "Lumen passkeys",
      markdown: "Add passkey sign-in to Lumen. Keep password sign-in available during the rollout.",
    });
    const page = await port.readPage(project.id, pageId);
    return {
      version: 1,
      scenarioId: CROSS_PROVIDER_SCENARIO_ID,
      scenarioRevision: 1,
      projectId: project.id,
      databaseViewId: project.defaultDatabaseViewId,
      pageIdsByKey: { brief: pageId },
      entityIdsByKey: { parentSession: parent.sessionId, releaseNotesSession: release.sessionId },
      minimumCommitSeq: page.commitSeq,
      materializedAt: new Date().toISOString(),
    };
  },
  async inspect(port, manifest) {
    for (const [key, title] of [
      ["parentSession", CROSS_PROVIDER_PARENT_TITLE],
      ["releaseNotesSession", CROSS_PROVIDER_RELEASE_TITLE],
    ]) {
      const id = manifest.entityIdsByKey?.[key];
      const session = id ? await port.readSession(id) : null;
      if (!session || session.projectId !== manifest.projectId || session.displayTitle !== title)
        throw new Error(`Lumen Session ${key} is missing`);
    }
    return { scenarioId: CROSS_PROVIDER_SCENARIO_ID, scenarioRevision: 1 };
  },
  parseFacts: parseScenarioFacts,
};
