import { createUuidV7 } from "../../../src/shared/uuid-v7";
import type { WorkflowStatus } from "../../../src/shared/workflow-status";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";

export const DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID =
  "database/context-menu-performance" as const;
export const DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_REVISION = 1 as const;
export const DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT = 160 as const;
export const DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT = 45 as const;

export interface DatabaseContextMenuPerformanceFacts extends ScenarioFacts {
  readonly totalRows: number;
  readonly propertyCount: number;
}

export const requireDatabaseContextMenuPerformanceFacts = (
  value: unknown,
): DatabaseContextMenuPerformanceFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID ||
    envelope.scenarioRevision !== DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_REVISION ||
    candidate.totalRows !== DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT ||
    candidate.propertyCount !== DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT
  ) {
    throw new Error("database/context-menu-performance facts are invalid");
  }
  return value as DatabaseContextMenuPerformanceFacts;
};

const statuses: readonly WorkflowStatus[] = ["triage", "plan", "build", "review", "ship"];

const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({
    name: "Context Menu Performance",
    sources: [workspace],
  });
  if (!project.defaultDatabaseViewId) {
    throw new Error("Context menu performance Project has no default Database View");
  }

  const pageIdsByKey: Record<string, string> = {};
  for (let index = 0; index < DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT; index += 1) {
    const key = `page-${String(index + 1).padStart(3, "0")}`;
    const seed: ScenarioPageSeed = {
      key,
      pageId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: project.id,
      status: statuses[index % statuses.length]!,
      title: `Performance Page ${String(index + 1).padStart(3, "0")}`,
      markdown: `Representative local-first Page body ${index + 1}.`,
    };
    await port.createPage(seed);
    pageIdsByKey[key] = seed.pageId;
  }
  const shape = await port.ensurePrimaryDataSourcePropertyCount(
    project.id,
    DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT,
  );
  if (shape.propertyCount !== DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT) {
    throw new Error("Context menu performance Property seed is incomplete");
  }
  return {
    version: 1,
    scenarioId: DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID,
    scenarioRevision: DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey,
    minimumCommitSeq: shape.commitSeq,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<DatabaseContextMenuPerformanceFacts> => {
  const [board, propertyCount] = await Promise.all([
    port.readBoard(manifest.projectId, manifest.databaseViewId, manifest.minimumCommitSeq),
    port.readPrimaryDataSourcePropertyCount(manifest.projectId),
  ]);
  return requireDatabaseContextMenuPerformanceFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    totalRows: board.totalRows,
    propertyCount,
  });
};

export const databaseContextMenuPerformanceScenario: ScenarioDomainRecipe = {
  id: DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID,
  revision: DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireDatabaseContextMenuPerformanceFacts,
};
