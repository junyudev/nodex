import { describe, expect, test } from "vite-plus/test";

import type { Project } from "../../../src/shared/types";
import type {
  ScenarioBoardObservation,
  ScenarioPageObservation,
  ScenarioPageSeed,
  ScenarioSeedPort,
} from "../contracts";
import { inspectScenario, materializeScenario } from "../seed/scenario-seed";
import {
  DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT,
  DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT,
  DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID,
  DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_REVISION,
} from "./database-context-menu-performance";

class PerformanceSeedPort implements ScenarioSeedPort {
  readonly pages: ScenarioPageSeed[] = [];
  ensuredPropertyCount = 0;

  async createProject(): Promise<Project> {
    return {
      id: "project:context-menu-performance",
      defaultDatabaseViewId: "view:context-menu-performance",
    } as unknown as Project;
  }

  async createPage(input: ScenarioPageSeed): Promise<{ readonly documentId: string }> {
    this.pages.push(input);
    return { documentId: `document:${input.key}` };
  }

  async createStandalonePage(): Promise<void> {
    throw new Error("Standalone Page seeding is not part of this scenario");
  }

  async createLibraryFile(): Promise<never> {
    throw new Error("File seeding is not part of this scenario");
  }

  async addPageFileEntry(): Promise<never> {
    throw new Error("Page File seeding is not part of this scenario");
  }

  async readPageFileInventory(): Promise<never> {
    throw new Error("Page File inspection is not part of this scenario");
  }

  async createDocumentCheckpoint(): Promise<never> {
    throw new Error("Document history seeding is not part of this scenario");
  }

  async ensurePrimaryDataSourcePropertyCount(
    _projectId: string,
    count: number,
  ): Promise<{ readonly commitSeq: number; readonly propertyCount: number }> {
    this.ensuredPropertyCount = count;
    return { commitSeq: 205, propertyCount: count };
  }

  async readPrimaryDataSourcePropertyCount(): Promise<number> {
    return this.ensuredPropertyCount;
  }

  async replaceOwnedDocument(): Promise<{ readonly commitSeq: number }> {
    throw new Error("Document replacement is not part of this scenario");
  }

  async readPage(): Promise<ScenarioPageObservation> {
    throw new Error("Page detail inspection is not part of this scenario");
  }

  async readBoard(): Promise<ScenarioBoardObservation> {
    return {
      totalRows: this.pages.length,
      commitSeq: 205,
      groups: { triage: 32, plan: 32, build: 32, review: 32, ship: 32 },
    };
  }

  async createRelatedChat(): Promise<never> {
    throw new Error("Related Chat seeding is not part of this scenario");
  }

  async readPageChatActivity(): Promise<never> {
    throw new Error("Page Chat inspection is not part of this scenario");
  }

  async readPageChats(): Promise<never> {
    throw new Error("Page Chat inspection is not part of this scenario");
  }
}

describe("database/context-menu-performance scenario", () => {
  test("materializes the production-scale Page and Property shape", async () => {
    const port = new PerformanceSeedPort();
    const manifest = await materializeScenario(
      DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID,
      port,
      "/tmp/workspace",
    );

    expect(port.pages).toHaveLength(DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT);
    expect(new Set(port.pages.map((page) => page.pageId)).size).toBe(
      DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT,
    );
    expect(port.ensuredPropertyCount).toBe(DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT);
    await expect(inspectScenario(manifest, port)).resolves.toEqual({
      scenarioId: DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_ID,
      scenarioRevision: DATABASE_CONTEXT_MENU_PERFORMANCE_SCENARIO_REVISION,
      totalRows: DATABASE_CONTEXT_MENU_PERFORMANCE_PAGE_COUNT,
      propertyCount: DATABASE_CONTEXT_MENU_PERFORMANCE_PROPERTY_COUNT,
    });
  });
});
