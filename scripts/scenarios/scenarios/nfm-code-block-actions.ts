import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID = "nfm-code-block-actions" as const;
export const NFM_CODE_BLOCK_ACTIONS_SCENARIO_REVISION = 1 as const;
export const NFM_CODE_BLOCK_ACTIONS_PAGE_KEY = "codeBlockActions" as const;

export const NFM_CODE_BLOCK_ACTIONS_SOURCE = "const answer:number=42";
export const NFM_CODE_BLOCK_ACTIONS_NFM = [
  "# Code block actions",
  "",
  "```typescript",
  NFM_CODE_BLOCK_ACTIONS_SOURCE,
  "```",
  "",
  "```coq",
  "Theorem identity : forall n : nat, n = n.",
  "```",
].join("\n");

export interface NfmCodeBlockActionsScenarioFacts extends ScenarioFacts {
  readonly totalRows: number;
  readonly page: {
    readonly pageId: string;
    readonly title: string;
    readonly documentReadiness: "pending_genesis" | "ready" | "failed";
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireNfmCodeBlockActionsScenarioFacts = (
  value: unknown,
): NfmCodeBlockActionsScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  const page = candidate.page;
  if (
    envelope.scenarioId !== NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID ||
    envelope.scenarioRevision !== NFM_CODE_BLOCK_ACTIONS_SCENARIO_REVISION ||
    typeof candidate.totalRows !== "number" ||
    candidate.totalRows < 0 ||
    !isRecord(page) ||
    typeof page.pageId !== "string" ||
    page.title !== "Exercise Code Block actions" ||
    !["pending_genesis", "ready", "failed"].includes(String(page.documentReadiness))
  ) {
    throw new Error("nfm-code-block-actions facts are invalid");
  }
  return value as NfmCodeBlockActionsScenarioFacts;
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Code Block Actions",
    sources: [workspace],
  });
  if (!project.defaultDatabaseViewId) {
    throw new Error("Code Block Actions Project has no default Database View");
  }
  const page: ScenarioPageSeed = {
    key: NFM_CODE_BLOCK_ACTIONS_PAGE_KEY,
    pageId: createUuidV7(),
    operationId: createUuidV7(),
    projectId: project.id,
    status: "build",
    title: "Exercise Code Block actions",
    nfm: NFM_CODE_BLOCK_ACTIONS_NFM,
  };
  await port.createPage(page);
  return {
    version: 1,
    scenarioId: NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID,
    scenarioRevision: NFM_CODE_BLOCK_ACTIONS_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: { [NFM_CODE_BLOCK_ACTIONS_PAGE_KEY]: page.pageId },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<NfmCodeBlockActionsScenarioFacts> => {
  const pageId = manifest.pageIdsByKey[NFM_CODE_BLOCK_ACTIONS_PAGE_KEY];
  if (!pageId) throw new Error("nfm-code-block-actions manifest has no Page fixture");
  const [board, page] = await Promise.all([
    port.readBoard(manifest.projectId, manifest.databaseViewId, manifest.minimumCommitSeq),
    port.readPage(manifest.projectId, pageId, manifest.minimumCommitSeq),
  ]);
  const facts = requireNfmCodeBlockActionsScenarioFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    totalRows: board.totalRows,
    page: {
      pageId: page.pageId,
      title: page.title,
      documentReadiness: page.documentReadiness,
    },
  });
  if (facts.totalRows !== Object.keys(manifest.pageIdsByKey).length) {
    throw new Error(
      `nfm-code-block-actions materialized facts do not match revision ${NFM_CODE_BLOCK_ACTIONS_SCENARIO_REVISION}`,
    );
  }
  return facts;
};

export const nfmCodeBlockActionsScenario: ScenarioDomainRecipe = {
  id: NFM_CODE_BLOCK_ACTIONS_SCENARIO_ID,
  revision: NFM_CODE_BLOCK_ACTIONS_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireNfmCodeBlockActionsScenarioFacts,
};
