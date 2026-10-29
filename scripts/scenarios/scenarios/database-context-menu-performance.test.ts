import { describe, expect, test } from "vite-plus/test";

import type { Project } from "../../../src/shared/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../src/shared/project-appearance";
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
      libraryId: "library:test",
      databaseId: "database:context-menu-performance",
      defaultDatabaseViewId: "view:context-menu-performance",
      lifecycle: "active",
      bindingRevision: 1,
      name: "Context Menu Performance",
      description: "",
      appearance: DEFAULT_PROJECT_APPEARANCE,
      sources: [],
      primaryWorkspaceRoot: null,
      pinned: false,
      pinnedOrder: null,
      created: new Date("2026-01-01T00:00:00.000Z"),
      updated: new Date("2026-01-01T00:00:00.000Z"),
    };
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

  async replaceOwnedDocument(): Promise<never> {
    throw new Error("Document replacement is not part of this scenario");
  }

  async readPageBlockTree(): Promise<never> {
    throw new Error("Document Block reads are not part of this scenario");
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

  async createStandaloneCanvas(): Promise<never> {
    throw new Error("Canvas seeding is not part of this scenario");
  }

  async readDatabase(): Promise<never> {
    throw new Error("Database detail inspection is not part of this scenario");
  }

  async applyDatabase(): Promise<never> {
    throw new Error("Database changes are not part of this scenario");
  }

  async createSidebarSection(): Promise<never> {
    throw new Error("Sidebar section seeding is not part of this scenario");
  }

  async createSessionInSidebarSection(): Promise<never> {
    throw new Error("Sidebar Session seeding is not part of this scenario");
  }

  async moveSidebarSectionItem(): Promise<never> {
    throw new Error("Sidebar item seeding is not part of this scenario");
  }

  async listSidebarSections(): Promise<never> {
    throw new Error("Sidebar section inspection is not part of this scenario");
  }

  async listSidebarSectionItems(): Promise<never> {
    throw new Error("Sidebar item inspection is not part of this scenario");
  }

  async sendInboxMessage(): Promise<never> {
    throw new Error("Inbox seeding is not part of this scenario");
  }

  async prepareInboxSuggestions(): Promise<never> {
    throw new Error("Not used by this scenario");
  }

  async proposeInboxDispatch(): Promise<never> {
    throw new Error("Inbox seeding is not part of this scenario");
  }

  async dispatchInboxEntries(): Promise<never> {
    throw new Error("Inbox seeding is not part of this scenario");
  }

  async keepInboxEntries(): Promise<never> {
    throw new Error("Inbox seeding is not part of this scenario");
  }

  async recordInboxSuggestionFailure(): Promise<never> {
    throw new Error("Inbox seeding is not part of this scenario");
  }

  async completeInboxDispatch(): Promise<never> {
    throw new Error("Inbox seeding is not part of this scenario");
  }

  async readInbox(): Promise<never> {
    throw new Error("Inbox inspection is not part of this scenario");
  }

  async createScheduledTask(): Promise<never> {
    throw new Error("Scheduled tasks are not part of this scenario");
  }

  async holdScheduledTaskNow(): Promise<never> {
    throw new Error("Scheduled firings are not part of this scenario");
  }

  async failScheduledRunNow(): Promise<never> {
    throw new Error("Scheduled failures are not part of this scenario");
  }

  async skipScheduledFiring(): Promise<never> {
    throw new Error("Scheduled firings are not part of this scenario");
  }

  async readScheduledTasks(): Promise<never> {
    throw new Error("Scheduled task inspection is not part of this scenario");
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
