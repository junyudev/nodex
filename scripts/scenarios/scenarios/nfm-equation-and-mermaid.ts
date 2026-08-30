import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const NFM_EQUATION_AND_MERMAID_SCENARIO_ID = "nfm-equation-and-mermaid" as const;
export const NFM_EQUATION_AND_MERMAID_SCENARIO_REVISION = 2 as const;
export const NFM_EQUATION_AND_MERMAID_PAGE_KEY = "equationAndMermaid" as const;
export const NFM_VIEWPORT_CONTINUITY_PAGE_KEY = "viewportContinuity" as const;

export const NFM_EQUATION_AND_MERMAID_SOURCE = "graph TD\n  Source --> Preview";
export const NFM_EQUATION_AND_MERMAID_NFM = [
  "# Equation and Mermaid",
  "",
  "Inline energy is $E = mc^2$.",
  "",
  "$$",
  String.raw`\int_0^1 x^2 \, dx = \frac{1}{3}`,
  "$$",
  "",
  "$$",
  String.raw`\frac{broken`,
  "$$",
  "",
  "$$",
  String.raw`\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}\qquad \prod_{k=1}^{m}\left(1+\frac{x}{k}\right)`,
  "$$",
  "",
  "```mermaid",
  NFM_EQUATION_AND_MERMAID_SOURCE,
  "```",
  "",
  "```typescript",
  "const answer: number = 42;",
  "```",
].join("\n");

export const NFM_VIEWPORT_CONTINUITY_NFM = [
  "# Viewport continuity",
  "",
  "$$",
  String.raw`\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}`,
  "$$",
  "",
  "```mermaid",
  NFM_EQUATION_AND_MERMAID_SOURCE,
  "```",
  "",
  "Viewport restoration anchor",
  "",
  ...Array.from(
    { length: 12 },
    (_, index) => `Viewport tail ${index + 1}: deterministic content after the restoration anchor.`,
  ),
].join("\n");

export interface NfmEquationAndMermaidScenarioFacts extends ScenarioFacts {
  readonly totalRows: number;
  readonly page: {
    readonly pageId: string;
    readonly title: string;
    readonly documentReadiness: "pending_genesis" | "ready" | "failed";
  };
  readonly viewportPage: {
    readonly pageId: string;
    readonly title: string;
    readonly documentReadiness: "pending_genesis" | "ready" | "failed";
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireNfmEquationAndMermaidScenarioFacts = (
  value: unknown,
): NfmEquationAndMermaidScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  const page = candidate.page;
  const viewportPage = candidate.viewportPage;
  if (
    envelope.scenarioId !== NFM_EQUATION_AND_MERMAID_SCENARIO_ID ||
    envelope.scenarioRevision !== NFM_EQUATION_AND_MERMAID_SCENARIO_REVISION ||
    candidate.totalRows !== 2 ||
    !isRecord(page) ||
    typeof page.pageId !== "string" ||
    page.title !== "Exercise Equation and Mermaid" ||
    !["pending_genesis", "ready", "failed"].includes(String(page.documentReadiness)) ||
    !isRecord(viewportPage) ||
    typeof viewportPage.pageId !== "string" ||
    viewportPage.title !== "Exercise Viewport Continuity" ||
    !["pending_genesis", "ready", "failed"].includes(String(viewportPage.documentReadiness))
  ) {
    throw new Error("nfm-equation-and-mermaid facts are invalid");
  }
  return value as NfmEquationAndMermaidScenarioFacts;
};

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Equation and Mermaid",
    sources: [workspace],
  });
  if (!project.defaultDatabaseViewId) {
    throw new Error("Equation and Mermaid Project has no default Database View");
  }
  const page: ScenarioPageSeed = {
    key: NFM_EQUATION_AND_MERMAID_PAGE_KEY,
    pageId: createUuidV7(),
    operationId: createUuidV7(),
    projectId: project.id,
    status: "build",
    title: "Exercise Equation and Mermaid",
    nfm: NFM_EQUATION_AND_MERMAID_NFM,
  };
  const viewportPage: ScenarioPageSeed = {
    key: NFM_VIEWPORT_CONTINUITY_PAGE_KEY,
    pageId: createUuidV7(),
    operationId: createUuidV7(),
    projectId: project.id,
    status: "build",
    title: "Exercise Viewport Continuity",
    nfm: NFM_VIEWPORT_CONTINUITY_NFM,
  };
  await port.createPage(page);
  await port.createPage(viewportPage);
  return {
    version: 1,
    scenarioId: NFM_EQUATION_AND_MERMAID_SCENARIO_ID,
    scenarioRevision: NFM_EQUATION_AND_MERMAID_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      [NFM_EQUATION_AND_MERMAID_PAGE_KEY]: page.pageId,
      [NFM_VIEWPORT_CONTINUITY_PAGE_KEY]: viewportPage.pageId,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<NfmEquationAndMermaidScenarioFacts> => {
  const pageId = manifest.pageIdsByKey[NFM_EQUATION_AND_MERMAID_PAGE_KEY];
  if (!pageId) throw new Error("nfm-equation-and-mermaid manifest has no Page fixture");
  const viewportPageId = manifest.pageIdsByKey[NFM_VIEWPORT_CONTINUITY_PAGE_KEY];
  if (!viewportPageId) throw new Error("nfm-equation-and-mermaid manifest has no viewport Page");
  const [board, page, viewportPage] = await Promise.all([
    port.readBoard(manifest.projectId, manifest.databaseViewId, manifest.minimumCommitSeq),
    port.readPage(manifest.projectId, pageId, manifest.minimumCommitSeq),
    port.readPage(manifest.projectId, viewportPageId, manifest.minimumCommitSeq),
  ]);
  return requireNfmEquationAndMermaidScenarioFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    totalRows: board.totalRows,
    page: {
      pageId: page.pageId,
      title: page.title,
      documentReadiness: page.documentReadiness,
    },
    viewportPage: {
      pageId: viewportPage.pageId,
      title: viewportPage.title,
      documentReadiness: viewportPage.documentReadiness,
    },
  });
};

export const nfmEquationAndMermaidScenario: ScenarioDomainRecipe = {
  id: NFM_EQUATION_AND_MERMAID_SCENARIO_ID,
  revision: NFM_EQUATION_AND_MERMAID_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireNfmEquationAndMermaidScenarioFacts,
};
