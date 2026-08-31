import { describe, expect, test } from "vite-plus/test";

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

class RecordingSeedPort implements ScenarioSeedPort {
  readonly pages: ScenarioPageSeed[] = [];
  readonly replacements: ScenarioDocumentReplacement[] = [];
  readonly #failFirstPageOnce: boolean;

  constructor(options: { readonly failFirstPageOnce?: boolean } = {}) {
    this.#failFirstPageOnce = options.failFirstPageOnce ?? false;
  }

  async createProject(): Promise<Project> {
    return {
      id: "project:board-dense",
      defaultDatabaseViewId: "view:board-dense",
    } as unknown as Project;
  }

  async createPage(input: ScenarioPageSeed): Promise<{ readonly documentId: string }> {
    this.pages.push(input);
    if (this.#failFirstPageOnce && this.pages.length === 1) {
      throw new Error("transient Page create failure");
    }
    return { documentId: `document:${input.key}` };
  }

  async createStandalonePage(): Promise<void> {
    throw new Error("Standalone Page seeding is not part of this scenario");
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

  async replaceOwnedDocument(
    input: ScenarioDocumentReplacement,
  ): Promise<{ readonly commitSeq: number }> {
    this.replacements.push(input);
    return { commitSeq: 12 };
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
