import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { parseScenarioFacts, type ScenarioDomainRecipe, type ScenarioManifest } from "../contracts";

const revision = 1;
const pages = [
  {
    key: "brief",
    title: "Hide completed tasks",
    nfm: "## Goal\n\nAdd a ‘Hide completed’ toggle to the task list.\n\n## Acceptance criteria\n\n- [ ] Show all tasks by default.\n- [ ] Hide completed tasks when the toggle is on.",
  },
  {
    key: "release",
    title: "Release checklist",
    nfm: "## Before release\n\n- [ ] Review the task filter.\n- [ ] Check keyboard navigation.\n- [ ] Write release notes.",
  },
  {
    key: "shortcuts",
    title: "Keyboard shortcuts",
    nfm: "## Keep the flow\n\nEvery task-list control should be reachable with the keyboard.",
  },
] as const;

/** Small, real Pages for recording the task-brief workflow in a disposable Profile. */
const createLandingScenario = (sharedPages: boolean): ScenarioDomainRecipe => {
  const scenarioId = sharedPages ? "landing/shared-pages" : "landing/showcase";
  return {
    id: scenarioId,
    revision,
    materialize: async (port, workspace): Promise<ScenarioManifest> => {
      const project = await port.createProject({ name: "Tinyboard", sources: [workspace] });
      if (!project.defaultDatabaseViewId) throw new Error("Tinyboard needs its default View");
      const pageIdsByKey: Record<string, string> = {};
      let minimumCommitSeq = 0;
      for (const page of pages) {
        const pageId = createUuidV7();
        await port.createPage({
          ...page,
          nfm:
            sharedPages && page.key === "brief"
              ? `${page.nfm}\n- [ ] Restore them when it is off, without changing their status.\n\n## Implementation notes`
              : page.nfm,
          pageId,
          operationId: createUuidV7(),
          projectId: project.id,
          status: "plan",
        });
        pageIdsByKey[page.key] = pageId;
        minimumCommitSeq = (await port.readPage(project.id, pageId)).commitSeq;
      }
      const briefPageId = pageIdsByKey.brief;
      if (!briefPageId) throw new Error("Tinyboard needs its brief Page");
      const chat = sharedPages
        ? await port.createRelatedChat({
            projectId: project.id,
            initialPageIds: [briefPageId],
            noThreadFallbackTitle: "Update implementation notes",
          })
        : null;
      minimumCommitSeq = (await port.readPage(project.id, briefPageId)).commitSeq;
      return {
        version: 1,
        scenarioId,
        scenarioRevision: revision,
        projectId: project.id,
        databaseViewId: project.defaultDatabaseViewId,
        pageIdsByKey,
        ...(chat ? { entityIdsByKey: { chat: chat.sessionId } } : {}),
        minimumCommitSeq,
        materializedAt: new Date().toISOString(),
      };
    },
    inspect: async (port, manifest) => {
      for (const expected of pages) {
        const pageId = manifest.pageIdsByKey[expected.key];
        if (!pageId) throw new Error(`Tinyboard is missing ${expected.key}`);
        const page = await port.readPage(manifest.projectId, pageId);
        if (page.title !== expected.title || page.documentReadiness !== "ready") {
          throw new Error(`Tinyboard Page is not ready: ${expected.title}`);
        }
      }
      return { scenarioId, scenarioRevision: revision };
    },
    parseFacts: (value) => {
      const facts = parseScenarioFacts(value);
      if (facts.scenarioId !== scenarioId || facts.scenarioRevision !== revision) {
        throw new Error("Unexpected Tinyboard scenario identity");
      }
      return facts;
    },
  };
};

export const landingShowcaseScenario = createLandingScenario(false);
export const landingSharedPagesScenario = createLandingScenario(true);
