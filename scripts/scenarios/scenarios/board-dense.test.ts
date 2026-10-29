import { describe, expect, test } from "vite-plus/test";

import { emptyDatabaseViewConfig } from "../../../src/renderer/lib/database-view-authoring";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../../src/shared/database-identities";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../src/shared/project-appearance";
import type {
  DatabaseApplyResultV2,
  DatabaseApplyV2,
  DatabaseModuleReadRequestV2,
  DatabaseModuleReadResultV2,
  DatabaseReadValueV2,
  DatabaseViewRecordV2,
} from "../../../src/shared/database-module-v2";
import type { Project } from "../../../src/shared/types";
import {
  parseScenarioFacts,
  parseScenarioManifest,
  type ScenarioBoardObservation,
  type ScenarioDocumentReplacement,
  type ScenarioPageObservation,
  type ScenarioPageSeed,
  type ScenarioSeedPort,
} from "../contracts";
import { inspectScenario, materializeScenario } from "../seed/scenario-seed";
import {
  BOARD_DENSE_PAGES,
  BOARD_DENSE_PRIMARY_PAGE_KEY,
  BOARD_DENSE_SCENARIO_ID,
  BOARD_DENSE_SCENARIO_REVISION,
  requireBoardDenseScenarioFacts,
} from "./board-dense";

const DATABASE_ID = parseDatabaseId("database:board-dense");
const BOARD_VIEW_ID = parseDatabaseViewId("view:board-dense");
const DATA_SOURCE_ID = parseDataSourceId("source:board-dense");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

class RecordingSeedPort implements ScenarioSeedPort {
  readonly pages: ScenarioPageSeed[] = [];
  readonly replacements: ScenarioDocumentReplacement[] = [];
  readonly #failFirstPageOnce: boolean;
  #commitSeq = 12;
  #listView: DatabaseViewRecordV2 | null = null;

  constructor(options: { readonly failFirstPageOnce?: boolean } = {}) {
    this.#failFirstPageOnce = options.failFirstPageOnce ?? false;
  }

  async createProject(): Promise<Project> {
    return {
      id: "project:board-dense",
      libraryId: "library:test",
      databaseId: DATABASE_ID,
      defaultDatabaseViewId: BOARD_VIEW_ID,
      lifecycle: "active",
      bindingRevision: 1,
      name: "Board Dense",
      description: "",
      appearance: DEFAULT_PROJECT_APPEARANCE,
      sources: [],
      primaryWorkspaceRoot: null,
      pinned: false,
      pinnedOrder: null,
      created: new Date(CREATED_AT),
      updated: new Date(CREATED_AT),
    };
  }

  async createPage(input: ScenarioPageSeed): Promise<{ readonly documentId: string }> {
    this.pages.push(input);
    if (this.#failFirstPageOnce && this.pages.length === 1) {
      throw new Error("transient Page create failure");
    }
    return { documentId: `document:${input.key}` };
  }

  async createStandaloneCanvas(): Promise<void> {
    throw new Error("Canvas seeding is not part of this scenario");
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

  async ensurePrimaryDataSourcePropertyCount(): Promise<{
    readonly commitSeq: number;
    readonly propertyCount: number;
  }> {
    return { commitSeq: 12, propertyCount: 0 };
  }

  async readPrimaryDataSourcePropertyCount(): Promise<number> {
    return 0;
  }

  async readDatabase(request: DatabaseModuleReadRequestV2): Promise<DatabaseModuleReadResultV2> {
    const board = {
      viewId: BOARD_VIEW_ID,
      databaseId: DATABASE_ID,
      dataSourceId: DATA_SOURCE_ID,
      name: "Board",
      layout: "board",
      config: emptyDatabaseViewConfig(),
      isDefault: true,
      revision: 1,
      rankKey: "a",
      lifecycle: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const satisfies DatabaseViewRecordV2;
    const target = request.read.target;
    const value: DatabaseReadValueV2 | null =
      target.kind === "view" && this.#listView?.viewId === target.viewId
        ? { kind: "view" as const, value: this.#listView }
        : target.kind === "project_default"
          ? {
              kind: "database" as const,
              value: {
                database: {
                  databaseId: DATABASE_ID,
                  libraryId: "library:test",
                  name: "Board Dense",
                  lifecycle: "active",
                  defaultViewId: BOARD_VIEW_ID,
                  metadataRevision: 1,
                  createdAt: CREATED_AT,
                  updatedAt: CREATED_AT,
                },
                dataSources: [
                  {
                    dataSourceId: DATA_SOURCE_ID,
                    libraryId: "library:test",
                    homeDatabaseId: DATABASE_ID,
                    name: "Pages",
                    schemaKey: "pages",
                    schemaRevision: 1,
                    lifecycle: "active",
                    rankKey: "a",
                    createdAt: CREATED_AT,
                    updatedAt: CREATED_AT,
                  },
                ],
                views: [board, ...(this.#listView ? [this.#listView] : [])],
              },
            }
          : null;
    if (!value) {
      return {
        ok: false,
        error: { code: "resource_not_found", message: "fixture read missing", retryable: false },
      };
    }
    return {
      ok: true,
      value: {
        projectId: request.projectId,
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: this.#commitSeq,
        value,
      },
    };
  }

  async applyDatabase(request: DatabaseApplyV2): Promise<DatabaseApplyResultV2> {
    for (const operation of request.operations) {
      if (operation.kind === "duplicate_view") {
        this.#listView = {
          viewId: operation.newViewId,
          databaseId: operation.databaseId,
          dataSourceId: DATA_SOURCE_ID,
          name: "Board copy",
          layout: "board",
          config: emptyDatabaseViewConfig(),
          isDefault: false,
          revision: 1,
          rankKey: "b",
          lifecycle: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      } else if (operation.kind === "change_view_layout" && this.#listView) {
        this.#listView = { ...this.#listView, layout: operation.layout, revision: 2 };
      } else if (operation.kind === "put_view" && this.#listView) {
        this.#listView = {
          ...this.#listView,
          name: operation.name,
          layout: operation.layout,
          config: operation.config,
          isDefault: operation.isDefault,
          revision: operation.expectedRevision + 1,
        };
      }
    }
    this.#commitSeq += 1;
    const view = this.#listView;
    if (!view) throw new Error("View edits must create the scenario's List View");
    return {
      ok: true,
      localCommit: {
        status: "committed",
        commit: {
          store_epoch: "epoch:test",
          commit_seq: this.#commitSeq,
          manifest_hash: "a".repeat(64),
        },
        delivery: null,
      },
      value: {
        operationId: request.operationId,
        projectId: request.projectId,
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        duplicate: false,
        operationKinds: request.operations.map((operation) => operation.kind),
        operationOutcomes: [],
        affectedDatabaseIds: [view.databaseId],
        affectedDataSourceIds: [view.dataSourceId],
        affectedPageIds: [],
        affectedViewIds: [view.viewId],
        committedRevisions: { [view.viewId]: view.revision },
        commitSeq: this.#commitSeq,
        committedAt: CREATED_AT,
      },
    };
  }

  async replaceOwnedDocument(
    input: ScenarioDocumentReplacement,
  ): Promise<{ readonly commitSeq: number; readonly createdBlockIds: readonly string[] }> {
    this.replacements.push(input);
    return { commitSeq: 12, createdBlockIds: [] };
  }

  async readPageBlockTree(): Promise<never> {
    throw new Error("Document Block reads are not part of this scenario");
  }

  async readPage(_projectId: string, pageId: string): Promise<ScenarioPageObservation> {
    return {
      pageId,
      title: "Unify Database View rendering",
      descriptionPreview: "Rendering contract",
      documentReadiness: "ready",
      commitSeq: 12,
    };
  }

  async readBoard(): Promise<ScenarioBoardObservation> {
    return {
      totalRows: BOARD_DENSE_PAGES.length,
      commitSeq: 12,
      groups: { triage: 3, plan: 2, build: 3, review: 1, ship: 1 },
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

describe("board/dense authoritative scenario", () => {
  test("materializes stable logical identities in domain order", async () => {
    const port = new RecordingSeedPort();
    const manifest = await materializeScenario(BOARD_DENSE_SCENARIO_ID, port, "/tmp/workspace");
    expect(port.pages.map(({ key, status }) => ({ key, status }))).toEqual(
      BOARD_DENSE_PAGES.map(({ key, status }) => ({ key, status })),
    );
    expect(new Set(port.pages.map((page) => page.pageId)).size).toBe(BOARD_DENSE_PAGES.length);
    expect(new Set(port.pages.map((page) => page.operationId)).size).toBe(BOARD_DENSE_PAGES.length);
    expect(port.replacements).toHaveLength(1);
    expect(port.replacements[0]?.pageId).toBe(manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY]);
    expect(manifest).toMatchObject({
      version: 1,
      scenarioId: BOARD_DENSE_SCENARIO_ID,
      scenarioRevision: BOARD_DENSE_SCENARIO_REVISION,
      projectId: "project:board-dense",
      databaseViewId: "view:board-dense",
    });
  });

  test("inspects normalized facts independently from generated UUIDs", async () => {
    const port = new RecordingSeedPort();
    const manifest = await materializeScenario(BOARD_DENSE_SCENARIO_ID, port, "/tmp/workspace");
    await expect(inspectScenario(manifest, port)).resolves.toEqual({
      scenarioId: BOARD_DENSE_SCENARIO_ID,
      scenarioRevision: BOARD_DENSE_SCENARIO_REVISION,
      totalRows: BOARD_DENSE_PAGES.length,
      groups: { triage: 3, plan: 2, build: 3, review: 1, ship: 1 },
      listViewId: manifest.entityIdsByKey?.listView,
      primaryBuildPage: {
        pageId: manifest.pageIdsByKey[BOARD_DENSE_PRIMARY_PAGE_KEY],
        title: "Unify Database View rendering",
        descriptionPreview: "Rendering contract",
        documentReadiness: "ready",
      },
    });
  });

  test("rejects malformed retained manifests and facts", () => {
    expect(() => parseScenarioManifest({ version: 1, scenarioId: "board/dense" })).toThrow(
      /Scenario manifest/u,
    );
    expect(() => parseScenarioFacts({ scenarioId: "board/dense", groups: {} })).toThrow(
      /Scenario facts/u,
    );
    expect(() =>
      requireBoardDenseScenarioFacts({
        scenarioId: "board/dense",
        scenarioRevision: BOARD_DENSE_SCENARIO_REVISION,
        groups: {},
      }),
    ).toThrow(/facts/u);
  });

  test("reuses canonical and operation identities for a bounded retry", async () => {
    const port = new RecordingSeedPort({ failFirstPageOnce: true });
    await materializeScenario(BOARD_DENSE_SCENARIO_ID, port, "/tmp/workspace");
    expect(port.pages).toHaveLength(11);
    expect(port.pages[1]).toBe(port.pages[0]);
    expect(port.pages[1]).toMatchObject({
      pageId: port.pages[0]?.pageId,
      operationId: port.pages[0]?.operationId,
    });
  });
});
