import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const NFM_TABLES_SCENARIO_ID = "nfm/tables" as const;
export const NFM_TABLES_SCENARIO_REVISION = 1 as const;
export const NFM_TABLES_PAGE_KEY = "tables" as const;

export const NFM_TABLES_NFM = [
  "# Tables",
  "",
  "An Agent-written status table with auto columns.",
  "",
  "| 渠道 | 进度 | 下一步 |",
  "| --- | --- | --- |",
  "| 小红书 | 图文草稿在 `opus-sol/xhs.html`，发出去我没法确认 | 你确认后贴在这里 |",
  "| X | 文案在 `opus-sol/review.html` | 先修 `opus-sol/status.html` 的 4 个问题（2 分钟），再发帖 |",
  "| B 站 | 分镜、提词器、无声样片已备好，缺配音 | 过稿加配音，约 40 分钟 |",
  "",
  "A small key/value table.",
  "",
  "| Key | Value |",
  "| --- | --- |",
  "| Model | gpt-6.2-sol |",
  "| Effort | xhigh |",
  "| Mode | async |",
  "",
  "Many short columns.",
  "",
  "| Capability | Pages | Chat | Board | Inbox | Files | Canvas |",
  "| --- | :---: | :---: | :---: | :---: | :---: | :---: |",
  "| Tables | ✓ | ✓ | — | ✓ | ✓ | — |",
  "| Resize | ✓ | — | — | — | — | — |",
  "| Header column | ✓ | — | — | — | — | — |",
  "",
  "Figures with a header column.",
  "",
  ':::table{header="both"}',
  "| Region | Q1 | Q2 | Q3 | Change |",
  "| --- | ---: | ---: | ---: | ---: |",
  "| APAC | 1,204 | 1,388 | 1,512 | +8.9% |",
  "| EMEA | 986 | 1,021 | 1,190 | +16.6% |",
  "| North America | 2,310 | 2,295 | 2,401 | +4.6% |",
  ":::",
  "",
  "Links and long tokens.",
  "",
  "| Source | Link | Notes |",
  "| --- | --- | --- |",
  "| Spec | https://developers.openai.com/codex/app-server.md#thread-start-request-shape | Primary reference for the thread lifecycle |",
  "| Architecture | `docs/ARCHITECTURE.md` | — |",
  "",
  "Pinned widths with cell colors.",
  "",
  ':::table{header="none" widths="160,220,140"}',
  '| Pinned 160 | Pinned 220 {background="blue"} | Pinned 140 |',
  "| --- | --- | --- |",
  '| A cell whose text is long enough to wrap inside its pinned width | Short {background="green"} | — |',
  ":::",
  "",
  "A new empty table.",
  "",
  ':::table{header="none"}',
  "| | |",
  "| --- | --- |",
  "| | |",
  "| | |",
  ":::",
].join("\n");

export interface NfmTablesScenarioFacts extends ScenarioFacts {
  readonly totalRows: number;
  readonly page: {
    readonly pageId: string;
    readonly title: string;
    readonly documentReadiness: "pending_genesis" | "ready" | "failed";
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireNfmTablesScenarioFacts = (value: unknown): NfmTablesScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  const page = candidate.page;
  if (
    envelope.scenarioId !== NFM_TABLES_SCENARIO_ID ||
    envelope.scenarioRevision !== NFM_TABLES_SCENARIO_REVISION ||
    typeof candidate.totalRows !== "number" ||
    candidate.totalRows < 0 ||
    !isRecord(page) ||
    typeof page.pageId !== "string" ||
    page.title !== "Exercise tables" ||
    !["pending_genesis", "ready", "failed"].includes(String(page.documentReadiness))
  ) {
    throw new Error("nfm/tables facts are invalid");
  }
  return value as NfmTablesScenarioFacts;
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Tables",
    sources: [workspace],
  });
  if (!project.defaultDatabaseViewId) {
    throw new Error("Tables Project has no default Database View");
  }
  const page: ScenarioPageSeed = {
    key: NFM_TABLES_PAGE_KEY,
    pageId: createUuidV7(),
    operationId: createUuidV7(),
    projectId: project.id,
    status: "doing",
    title: "Exercise tables",
    markdown: NFM_TABLES_NFM,
  };
  await port.createPage(page);
  return {
    version: 1,
    scenarioId: NFM_TABLES_SCENARIO_ID,
    scenarioRevision: NFM_TABLES_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: { [NFM_TABLES_PAGE_KEY]: page.pageId },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<NfmTablesScenarioFacts> => {
  const pageId = manifest.pageIdsByKey[NFM_TABLES_PAGE_KEY];
  if (!pageId) throw new Error("nfm/tables manifest has no Page fixture");
  const [board, page] = await Promise.all([
    port.readBoard(manifest.projectId, manifest.databaseViewId, manifest.minimumCommitSeq),
    port.readPage(manifest.projectId, pageId, manifest.minimumCommitSeq),
  ]);
  const facts = requireNfmTablesScenarioFacts({
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
      `nfm/tables materialized facts do not match revision ${NFM_TABLES_SCENARIO_REVISION}`,
    );
  }
  return facts;
};

export const nfmTablesScenario: ScenarioDomainRecipe = {
  id: NFM_TABLES_SCENARIO_ID,
  revision: NFM_TABLES_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireNfmTablesScenarioFacts,
};
