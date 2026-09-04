import { selectEditorBlockRange } from "./support/select-editor-block-range";
import {
  dragBlockFromEditorWithMouse,
  dispatchEditorAncestorScroll,
} from "./support/drag-block-with-mouse";
import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type CDPSession,
  type ElectronApplication,
  type Locator,
  type Page,
} from "playwright";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "../../config/renderer-vite-shared";
import { CoreClient } from "../../src/main/core-client/core-client";
import { LARGE_CONTENT_FIXTURE_SIZES } from "../../src/main/performance/large-content-fixtures";
import {
  compilePageLifecycleRequestV2,
  type PageLifecyclePreflightSnapshotV2,
} from "../../src/shared/page-lifecycle-v2-runtime";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import {
  attachNodexStructuralClipboardWriteClaim,
  encodeNodexStructuralClipboardDescriptor,
  NODEX_STRUCTURAL_CLIPBOARD_MIME,
} from "../../src/shared/clipboard-paste";
import type { LibraryPageFileManifest } from "../../src/shared/library-module";
import {
  ElectronScenarioHarness,
  stopNodexElectronApplication as stopApplication,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { openBoardPageFromCard } from "./support/open-board-page";

const repositoryRoot = process.cwd();
const largeContentFixtureRoot = path.join(repositoryRoot, "tests/e2e/large-content-fixture");
const largeContentElectronMain = path.join(largeContentFixtureRoot, "electron-main.cjs");

type LargeContentScenario = "workspace" | "markdown" | "tool" | "startup";

interface LargeContentScenarioMetrics {
  scenario: LargeContentScenario;
  maxLongTaskMs: number;
  traceMaxRunTaskMs: number;
  domNodes: number;
  accessibilityNodes: number;
  tracePath: string;
  traceBytes: number;
  traceSha256: string;
}

interface ConvergenceProject {
  projectId: string;
  storeEpoch: string;
  defaultDatabaseViewId: string;
}

interface ConvergencePage {
  pageId: string;
  documentId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, label: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${label} is missing from the Electron E2E response`);
};

const requireIpcValue = <T>(result: unknown, label: string): T => {
  if (!isRecord(result) || result.ok !== true || !("value" in result)) {
    const error =
      isRecord(result) && isRecord(result.error)
        ? String(result.error.message ?? "unknown IPC error")
        : "unknown IPC error";
    throw new Error(`${label} failed: ${error}`);
  }
  return result.value as T;
};

async function invokeIpc(
  page: Page,
  channel: string,
  ...args: readonly unknown[]
): Promise<unknown> {
  return await page.evaluate(
    async ({ channel: targetChannel, args: targetArgs }) =>
      await window.api?.invoke(targetChannel, ...targetArgs),
    { channel, args },
  );
}

async function readConvergencePageFiles(
  page: Page,
  projectId: string,
  pageId: string,
): Promise<LibraryPageFileManifest> {
  const snapshot = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(
      page,
      "library-module:read",
      { kind: "project", projectId },
      {
        read: {
          mode: "page_files",
          pageId,
          limit: 100,
          includeDeleted: false,
        },
      },
    ),
    `Read Page Files for ${pageId}`,
  );
  const value = snapshot.value;
  if (!isRecord(value) || value.kind !== "page_files" || !isRecord(value.value)) {
    throw new Error(`Page Files for ${pageId} returned an unexpected value`);
  }
  return value.value as unknown as LibraryPageFileManifest;
}

async function createConvergenceProject(
  page: Page,
  name: string,
  workspace: string,
): Promise<ConvergenceProject> {
  const project = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(page, "projects:create", {
      operationId: createBoundedOperationId("e2e.project.create"),
      payload: {
        projectId: createUuidV7(),
        input: { name, sources: [workspace] },
      },
    }),
    "Project creation",
  );
  const projectId = requireString(project.id, "Project id");
  const defaultDatabaseViewId = requireString(
    project.defaultDatabaseViewId,
    "Project default Database View id",
  );
  const metadata = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(
      page,
      "library-module:read",
      { kind: "library" },
      {
        read: { mode: "metadata" },
      },
    ),
    "Library metadata read",
  );
  return {
    projectId,
    defaultDatabaseViewId,
    storeEpoch: requireString(metadata.storeEpoch, "Library store epoch"),
  };
}

async function createConvergencePage(
  page: Page,
  project: ConvergenceProject,
  title: string,
): Promise<ConvergencePage> {
  const pageId = createUuidV7();
  const documentId = createUuidV7();
  const result = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(
      page,
      "library-module:apply",
      { kind: "library" },
      {
        operationId: createUuidV7(),
        storeEpoch: project.storeEpoch,
        operation: {
          kind: "create_page",
          pageId,
          documentId,
          title,
          parent: { kind: "library" },
        },
      },
    ),
    `Create ${title}`,
  );
  const createdTarget = result.createdTarget;
  if (!isRecord(createdTarget)) {
    throw new Error(`Create ${title} returned no Page target`);
  }
  expect(createdTarget.kind).toBe("page");
  expect(requireString(createdTarget.pageId, `${title} Page id`)).toBe(pageId);
  await requireIpcValue<Record<string, unknown>>(
    await invokeIpc(
      page,
      "library-module:apply",
      { kind: "library" },
      {
        operationId: createUuidV7(),
        storeEpoch: project.storeEpoch,
        operation: {
          kind: "grant_project_access",
          projectId: project.projectId,
          target: { kind: "page", pageId },
          access: "read_write",
        },
      },
    ),
    `Grant ${title}`,
  );
  return { pageId, documentId };
}

async function createConvergenceBoardPage(
  page: Page,
  project: ConvergenceProject,
  title: string,
  description: string,
): Promise<ConvergencePage> {
  const pageId = createUuidV7();
  const preflight = requireIpcValue<PageLifecyclePreflightSnapshotV2>(
    await invokeIpc(page, "pages:lifecycle:preflight", project.projectId, pageId),
    `Preflight ${title}`,
  );
  const request = compilePageLifecycleRequestV2({
    intent: {
      kind: "create",
      operationId: createUuidV7(),
      projectId: project.projectId,
      pageId,
      status: "triage",
      input: {
        id: pageId,
        title,
        description,
      },
    },
    preflight,
  });
  const receipt = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(page, "pages:lifecycle:apply", project.projectId, request),
    `Create Board Page ${title}`,
  );
  return {
    pageId,
    documentId: requireString(receipt.documentId, `${title} document id`),
  };
}

interface SeededConvergencePage extends ConvergencePage {
  blockIds: readonly string[];
}

async function seedConvergenceDocument(
  page: Page,
  project: ConvergenceProject,
  source: ConvergencePage,
  nfm = "Keep block\nDragged source",
): Promise<SeededConvergencePage> {
  const descriptor = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(page, "block-document:owned:prepare", project.projectId, source.pageId),
    "Prepare source Page document",
  );
  const documentId = requireString(descriptor.documentId, "Source document id");
  if (documentId !== source.documentId) {
    throw new Error("Source Page document identity changed during preparation");
  }

  const mutation = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(page, "block-documents:mutate", project.projectId, documentId, {
      mutationId: createUuidV7(),
      projectId: project.projectId,
      storeEpoch: project.storeEpoch,
      actor: {},
      documentId,
      generation: descriptor.generation,
      expectedHeadSeq: descriptor.headSeq,
      nfm,
    }),
    "Seed source Page document",
  );
  if (!Array.isArray(mutation.createdBlockIds)) {
    throw new Error("Seed source Page document returned no created block ids");
  }
  const blockIds = mutation.createdBlockIds.map((blockId, index) =>
    requireString(blockId, `Seeded block id ${index}`),
  );
  if (blockIds.length < 2) {
    throw new Error("Seed source Page document must contain a transferable block");
  }
  return { ...source, blockIds };
}

async function createConvergenceSubpage(
  page: Page,
  project: ConvergenceProject,
  parent: ConvergencePage,
  title: string,
  beforeBlockId: string,
): Promise<ConvergencePage> {
  const descriptor = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(page, "block-document:owned:prepare", project.projectId, parent.pageId),
    `Prepare ${title} parent`,
  );
  const pageId = createUuidV7();
  const documentId = createUuidV7();
  requireIpcValue<Record<string, unknown>>(
    await invokeIpc(
      page,
      "library-module:apply",
      { kind: "project", projectId: project.projectId },
      {
        operationId: createUuidV7(),
        storeEpoch: project.storeEpoch,
        operation: {
          kind: "create_page",
          pageId,
          documentId,
          title,
          parent: {
            kind: "page",
            pageId: parent.pageId,
            expectedDocumentGeneration: descriptor.generation,
            expectedDocumentHeadSeq: descriptor.headSeq,
            insertion: {
              kind: "before",
              anchorBlockId: beforeBlockId,
            },
          },
        },
      },
    ),
    `Create ${title}`,
  );
  return { pageId, documentId };
}

async function expectClosingSideMenuToBeInert({
  page,
  sourceBlock,
  sourceEditor,
}: {
  page: Page;
  sourceBlock: Locator;
  sourceEditor: Locator;
}): Promise<void> {
  const sourceBlockContent = sourceBlock.locator(":scope > .bn-block-content");
  await sourceBlockContent.hover();
  const dragHandle = sourceEditor.locator(
    '.bn-side-menu button.nfm-side-menu-drag-handle[draggable="true"]:visible',
  );
  await expect(dragHandle).toHaveCount(1);
  const handleCenter = await dragHandle.evaluate((handle) => {
    const box = handle.getBoundingClientRect();
    return {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  });
  await page.mouse.move(handleCenter.x, handleCenter.y);
  await dispatchEditorAncestorScroll({ page, sourceEditor });

  expect(
    await page.evaluate(({ x, y }) => {
      return document.elementsFromPoint(x, y).some((element) => {
        return element.closest(".bn-side-menu") !== null;
      });
    }, handleCenter),
  ).toBe(false);
}

async function dragListRowWithMouse({
  page,
  sourceRow,
  targetRow,
  position,
  expectedOverlayCount = 1,
}: {
  page: Page;
  sourceRow: Locator;
  targetRow: Locator;
  position: "before" | "after" | "center" | "nest";
  expectedOverlayCount?: number;
}): Promise<void> {
  await sourceRow.scrollIntoViewIfNeeded();
  await sourceRow.hover();
  await expect(sourceRow).toHaveAttribute("draggable", "true");
  const dragSurface = sourceRow.locator('[data-list-grid-column="indent"]');
  const handleBox = await dragSurface.boundingBox();
  if (!handleBox) throw new Error("List row drag surface has no layout box");
  const sourcePoint = {
    x: handleBox.x + handleBox.width / 2,
    y: handleBox.y + handleBox.height / 2,
  };
  const targetBox = await targetRow.boundingBox();
  if (!targetBox) throw new Error("List target row has no layout box");
  const targetRatio = position === "before" ? 0.14 : position === "after" ? 0.86 : 0.5;
  const targetPoint = {
    x: targetBox.x + Math.min(targetBox.width - 24, Math.max(80, targetBox.width * 0.45)),
    y: targetBox.y + targetBox.height * targetRatio,
  };

  let mouseReleased = false;
  let altPressed = false;
  try {
    if (position === "nest") {
      await page.keyboard.down("Alt");
      altPressed = true;
    }
    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.mouse.move(sourcePoint.x + 12, sourcePoint.y, { steps: 4 });
    const overlay = page.locator('[data-database-list-drag-overlay="true"]');
    await expect(overlay).toBeVisible();
    if (expectedOverlayCount > 1) {
      await expect(overlay.getByText(String(expectedOverlayCount), { exact: true })).toBeVisible();
    }
    await expect(sourceRow).toHaveCSS("opacity", "0.7");
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 24 });
    await page.mouse.move(targetPoint.x + 1, targetPoint.y);
    await page.mouse.move(targetPoint.x + 2, targetPoint.y);
    if (position !== "nest") {
      await expect(targetRow).toHaveAttribute(
        "data-drop-position",
        position === "before" ? "before" : "after",
      );
    }
    await page.mouse.up();
    mouseReleased = true;
    await expect(overlay).toBeHidden();
  } finally {
    if (!mouseReleased) await page.mouse.up().catch(() => undefined);
    if (altPressed) await page.keyboard.up("Alt").catch(() => undefined);
  }
}

interface ConvergenceDatabase {
  dataSourceId: string;
  viewId: string;
}

interface BoardTransferPerformanceMetrics {
  fixtureSeed: string;
  buildMode: string;
  platform: string;
  architecture: string;
  osRelease: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  normalizedOneMinuteLoadAtStart: number;
  normalizedOneMinuteLoadMax: number;
  fixturePreparationMs: number;
  boardInitialRenderMs: number;
  transferCommitMs: number;
  transferToSourceRemovalMs: number;
  transferToCardMs: number;
  endToEndMs: number;
  sourceBlockCount: number;
  movedChildBlockCount: number;
  initialBoardPageCount: number;
  finalBoardPageCount: number;
  initialRenderedBoardCardCount: number;
  finalRenderedBoardCardCount: number;
  initialDomNodes: number;
  finalDomNodes: number;
  rendererLongTaskCount: number;
  rendererLongTaskTotalMs: number;
  rendererMaxLongTaskMs: number;
  peakWorkingSetBytes: number;
  firstTransferVisibilityFacts: Array<{
    relationKind: string;
    operation: string;
    count: number;
  }>;
  firstTransferVisibilityRows: Array<{
    relationKind: string;
    operation: string;
    oldRow: string | null;
    newRow: string | null;
  }>;
  transferCommitP50Ms: number;
  transferCommitP95Ms: number;
  transferCommitP99Ms: number | null;
  transferCommitMaxMs: number;
  transferToSourceRemovalP50Ms: number;
  transferToSourceRemovalP95Ms: number;
  transferToSourceRemovalP99Ms: number | null;
  transferToSourceRemovalMaxMs: number;
  transferToCardP50Ms: number;
  transferToCardP95Ms: number;
  transferToCardP99Ms: number | null;
  transferToCardMaxMs: number;
  coreStages: Record<CoreTransferStage, CoreTransferStageSummary>;
  rawSamples: {
    transferCommitMs: number[];
    transferToSourceRemovalMs: number[];
    transferToCardMs: number[];
    normalizedOneMinuteLoad: number[];
    coreStages: Record<CoreTransferStage, number[]>;
  };
  rounds: number;
}

type CoreHealthMetrics = Awaited<ReturnType<CoreClient["health"]>>["metrics"];

const CORE_TRANSFER_STAGES = {
  writerQueueWait: "writer_queue_wait",
  writerExecution: "writer_execution",
  transaction: "transaction_duration",
  prepare: "block_transfer_prepare_duration",
  reconstruct: "block_transfer_reconstruct_duration",
  decode: "block_transfer_decode_duration",
  transform: "block_transfer_transform_duration",
  encode: "block_transfer_encode_duration",
  apply: "block_transfer_apply_duration",
  packetPublication: "local_commit_publication_duration",
} as const satisfies Record<string, keyof CoreHealthMetrics>;

type CoreTransferStage = keyof typeof CORE_TRANSFER_STAGES;

interface CoreTransferStageSummary {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number | null;
  maxMs: number;
  observationCount: number;
}

const HIGH_PRESSURE_SIBLING_BLOCK_COUNT = 100;
const HIGH_PRESSURE_CHILD_BLOCK_COUNT = 100;
const HIGH_PRESSURE_BOARD_PAGE_COUNT = 100;
const HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT = 50;
const HIGH_PRESSURE_BOARD_PLAN_PAGE_COUNT =
  HIGH_PRESSURE_BOARD_PAGE_COUNT - HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT;
const HIGH_PRESSURE_SOURCE_REMAINDER = [
  ...Array.from(
    { length: HIGH_PRESSURE_SIBLING_BLOCK_COUNT },
    (_, index) => `before-placeholder-${index.toString().padStart(3, "0")}`,
  ),
  ...Array.from(
    { length: HIGH_PRESSURE_SIBLING_BLOCK_COUNT },
    (_, index) => `after-placeholder-${index.toString().padStart(3, "0")}`,
  ),
].join(" ");
const HIGH_PRESSURE_ROUNDS = Math.max(
  1,
  Math.min(100, Number.parseInt(process.env.NODEX_HIGH_PRESSURE_ROUNDS ?? "1", 10) || 1),
);
const HIGH_PRESSURE_TEST_TIMEOUT_MS = 180_000 + Math.max(0, HIGH_PRESSURE_ROUNDS - 1) * 2_000;
const PAGE_READY_HISTORY_COMMITS = 14_419;
const PAGE_READY_ROUNDS = 20;
const IDLE_CPU_SAMPLE_SECONDS = Math.max(
  1,
  Math.min(60, Number.parseInt(process.env.NODEX_IDLE_CPU_SAMPLE_SECONDS ?? "60", 10) || 60),
);

const buildHighPressureSourceNfm = (titlePrefix = "title-A"): string =>
  [
    ...Array.from(
      { length: HIGH_PRESSURE_SIBLING_BLOCK_COUNT },
      (_, index) => `before-placeholder-${index.toString().padStart(3, "0")}`,
    ),
    titlePrefix,
    ...Array.from(
      { length: HIGH_PRESSURE_CHILD_BLOCK_COUNT },
      (_, index) => `\tchild-placeholder-${index.toString().padStart(3, "0")}`,
    ),
    ...Array.from(
      { length: HIGH_PRESSURE_SIBLING_BLOCK_COUNT },
      (_, index) => `after-placeholder-${index.toString().padStart(3, "0")}`,
    ),
  ].join("\n");

function readVisibilityFactCounts(
  nodexHome: string,
  commitSeq: number,
): BoardTransferPerformanceMetrics["firstTransferVisibilityFacts"] {
  const raw = execFileSync(
    "sqlite3",
    [
      "-json",
      path.join(nodexHome, "nodex.db"),
      `SELECT relation_kind AS relationKind, operation, count(*) AS count
       FROM local_commit_visibility_dirty_facts
       WHERE commit_seq = ${commitSeq}
       GROUP BY relation_kind, operation
       ORDER BY relation_kind, operation`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (!raw) return [];
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    throw new Error("Visibility fact evidence is not an array");
  }
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.relationKind !== "string" ||
      typeof row.operation !== "string" ||
      typeof row.count !== "number"
    ) {
      throw new Error("Visibility fact evidence is invalid");
    }
    return {
      relationKind: row.relationKind,
      operation: row.operation,
      count: row.count,
    };
  });
}

function readVisibilityFactRows(
  nodexHome: string,
  commitSeq: number,
): BoardTransferPerformanceMetrics["firstTransferVisibilityRows"] {
  const raw = execFileSync(
    "sqlite3",
    [
      "-json",
      path.join(nodexHome, "nodex.db"),
      `SELECT relation_kind AS relationKind, operation,
              old_row_json AS oldRow, new_row_json AS newRow
       FROM local_commit_visibility_dirty_facts
       WHERE commit_seq = ${commitSeq}
       ORDER BY fact_seq`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (!raw) return [];
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) {
    throw new Error("Visibility fact row evidence is not an array");
  }
  return rows.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.relationKind !== "string" ||
      typeof row.operation !== "string" ||
      (row.oldRow !== null && typeof row.oldRow !== "string") ||
      (row.newRow !== null && typeof row.newRow !== "string")
    ) {
      throw new Error("Visibility fact row evidence is invalid");
    }
    return {
      relationKind: row.relationKind,
      operation: row.operation,
      oldRow: row.oldRow,
      newRow: row.newRow,
    };
  });
}

const summarizeDurations = (
  values: readonly number[],
): {
  p50: number;
  p95: number;
  p99: number | null;
  max: number;
} => {
  if (values.length === 0) {
    throw new Error("Performance sample set cannot be empty");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: values.length >= 100 ? percentile(0.99) : null,
    max: sorted.at(-1) ?? 0,
  };
};

const durationMetricDelta = (
  before: CoreHealthMetrics,
  after: CoreHealthMetrics,
  key: (typeof CORE_TRANSFER_STAGES)[CoreTransferStage],
): { durationMs: number; observationCount: number } => {
  const beforeMetric = before[key];
  const afterMetric = after[key];
  if (!isRecord(beforeMetric) || !isRecord(afterMetric)) {
    throw new Error(`Core health metric ${key} is unavailable`);
  }
  const beforeTotal = beforeMetric.total_micros;
  const afterTotal = afterMetric.total_micros;
  const beforeCount = beforeMetric.count;
  const afterCount = afterMetric.count;
  if (
    typeof beforeTotal !== "number" ||
    typeof afterTotal !== "number" ||
    typeof beforeCount !== "number" ||
    typeof afterCount !== "number" ||
    afterTotal < beforeTotal ||
    afterCount < beforeCount
  ) {
    throw new Error(`Core health metric ${key} moved backwards`);
  }
  return {
    durationMs: (afterTotal - beforeTotal) / 1_000,
    observationCount: afterCount - beforeCount,
  };
};

const buildBoardFixtureNfm = (): string =>
  [
    "Keep board fixture",
    ...Array.from(
      { length: HIGH_PRESSURE_BOARD_PAGE_COUNT },
      (_, index) => `board-fixture-${index.toString().padStart(3, "0")}`,
    ),
  ].join("\n");

interface SyntheticHistoryResult {
  readonly commitCountBefore: number;
  readonly commitCountAfter: number;
  readonly commitHeadAfter: number;
  readonly databaseBytes: number;
}

const sqliteScalarRow = (databasePath: string, query: string): readonly string[] =>
  execFileSync("sqlite3", ["-batch", "-noheader", "-separator", "|", databasePath, query], {
    encoding: "utf8",
  })
    .trim()
    .split("|");

const requireSafeInteger = (value: string | undefined, label: string): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  throw new Error(`${label} is not a non-negative safe integer`);
};

function seedSyntheticLocalCommitHistory(
  nodexHome: string,
  targetCommitCount: number,
): SyntheticHistoryResult {
  const databasePath = path.join(nodexHome, "nodex.db");
  const [rawCount, rawHead, storeEpoch] = sqliteScalarRow(
    databasePath,
    "SELECT count(*), COALESCE(max(commit_seq), 0), " +
      "(SELECT store_epoch FROM block_store_metadata WHERE id = 1) " +
      "FROM local_commits;",
  );
  const commitCountBefore = requireSafeInteger(rawCount, "History commit count");
  const commitHeadBefore = requireSafeInteger(rawHead, "History commit head");
  if (!storeEpoch) throw new Error("History fixture Store epoch is missing");
  if (commitCountBefore >= targetCommitCount) {
    throw new Error("History fixture already meets or exceeds its target");
  }
  const missing = targetCommitCount - commitCountBefore;
  const finalCommitSeq = commitHeadBefore + missing;
  const sql = `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
WITH RECURSIVE fixture_seq(commit_seq) AS (
  SELECT ${commitHeadBefore + 1}
  UNION ALL
  SELECT commit_seq + 1 FROM fixture_seq WHERE commit_seq < ${finalCommitSeq}
)
INSERT INTO local_commits(
  commit_seq, store_epoch, operation_id, committed_at,
  projection_impact_json, canonical_hash, intent_hash, projection_json,
  receipt_json, audience_json, finalized, manifest_json
)
SELECT
  commit_seq,
  '${storeEpoch}',
  'm3-history-fixture-' || printf('%08d', commit_seq),
  '2026-08-10T00:00:00.000Z',
  '{}',
  printf('%064x', commit_seq),
  printf('%064x', commit_seq),
  '{}', '{}', '{}', 1, '{}'
FROM fixture_seq;
COMMIT;
`;
  execFileSync("sqlite3", ["-batch", databasePath, sql], { encoding: "utf8" });
  const [rawFinalCount, rawFinalHead, integrity] = sqliteScalarRow(
    databasePath,
    "SELECT count(*), COALESCE(max(commit_seq), 0), " +
      "(SELECT integrity_check FROM pragma_integrity_check) FROM local_commits;",
  );
  const commitCountAfter = requireSafeInteger(rawFinalCount, "Final history commit count");
  const commitHeadAfter = requireSafeInteger(rawFinalHead, "Final history commit head");
  if (commitCountAfter !== targetCommitCount || integrity !== "ok") {
    throw new Error("Synthetic LocalCommit history failed its integrity check");
  }
  return {
    commitCountBefore,
    commitCountAfter,
    commitHeadAfter,
    databaseBytes: fs.statSync(databasePath).size,
  };
}

interface ElectronProcessCpuSample {
  readonly creationTime: number;
  readonly cumulativeSeconds: number;
  readonly percent: number;
  readonly pid: number;
  readonly type: string;
}

const readElectronProcessCpu = async (
  application: ElectronApplication,
): Promise<readonly ElectronProcessCpuSample[]> =>
  await application.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      creationTime: metric.creationTime,
      cumulativeSeconds: metric.cpu.cumulativeCPUUsage ?? 0,
      percent: metric.cpu.percentCPUUsage,
      pid: metric.pid,
      type: metric.type,
    })),
  );

const parseProcessCpuTime = (raw: string): number => {
  const fields = raw
    .trim()
    .split(":")
    .map((field) => Number.parseInt(field, 10));
  if (fields.some((field) => !Number.isSafeInteger(field) || field < 0)) {
    throw new Error("Process CPU time is invalid");
  }
  if (fields.length === 2) return fields[0]! * 60 + fields[1]!;
  if (fields.length === 3) {
    return fields[0]! * 3_600 + fields[1]! * 60 + fields[2]!;
  }
  throw new Error("Process CPU time has an unsupported shape");
};

const readProcessCpuTime = (pid: number): number =>
  parseProcessCpuTime(execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }));

const readProcessCpuPercent = (pid: number): number => {
  const value = Number.parseFloat(
    execFileSync("ps", ["-o", "%cpu=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
  if (Number.isFinite(value) && value >= 0) return value;
  throw new Error("Process CPU percentage is invalid");
};

const cumulativeElectronCpuDelta = (
  before: readonly ElectronProcessCpuSample[],
  after: readonly ElectronProcessCpuSample[],
): number => {
  const beforeByIdentity = new Map(
    before.map((sample) => [`${sample.pid}:${sample.creationTime}`, sample.cumulativeSeconds]),
  );
  return after.reduce((total, sample) => {
    const previous = beforeByIdentity.get(`${sample.pid}:${sample.creationTime}`);
    if (previous === undefined) return total;
    return total + Math.max(0, sample.cumulativeSeconds - previous);
  }, 0);
};

async function readConvergenceDatabase(
  page: Page,
  project: ConvergenceProject,
): Promise<ConvergenceDatabase> {
  const snapshot = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(page, "database-module:read", project.projectId, {
      projectId: project.projectId,
      read: {
        target: { kind: "project_default" },
        mode: "database",
      },
    }),
    "Read Project Database",
  );
  const value = snapshot.value;
  if (!isRecord(value) || value.kind !== "database" || !isRecord(value.value)) {
    throw new Error("Project Database read returned an unexpected value");
  }
  if (!Array.isArray(value.value.views)) {
    throw new Error("Project Database read returned no views");
  }
  const view = value.value.views.find(
    (candidate) => isRecord(candidate) && candidate.viewId === project.defaultDatabaseViewId,
  );
  if (!isRecord(view)) {
    throw new Error("Project Database read returned no default view");
  }
  return {
    dataSourceId: requireString(view.dataSourceId, "Project Data Source id"),
    viewId: requireString(view.viewId, "Project Database View id"),
  };
}

async function transferBoardFixturePages(
  page: Page,
  project: ConvergenceProject,
  database: ConvergenceDatabase,
  documentId: string,
  rootBlockIds: readonly string[],
  groupKey: string,
  label: string,
): Promise<readonly string[]> {
  const resultPageIds: string[] = [];
  for (let offset = 0; offset < rootBlockIds.length; offset += 20) {
    const batch = rootBlockIds.slice(offset, offset + 20);
    const result = requireIpcValue<Record<string, unknown>>(
      await invokeIpc(page, "blocks:transfer", project.projectId, {
        operationId: createUuidV7(),
        projectId: project.projectId,
        storeEpoch: project.storeEpoch,
        mode: "move",
        rootBlockIds: batch,
        causalDependencies: [],
        source: { kind: "document", documentId },
        target: {
          kind: "data_source",
          dataSourceId: database.dataSourceId,
          placement: {
            kind: "direct",
            viewId: database.viewId,
            presentationOverride: { layout: "board" },
            groupKey,
          },
        },
        promotionPolicy: "literal",
      }),
      `${label} batch ${Math.floor(offset / 20) + 1}`,
    );
    if (!Array.isArray(result.resultRootBlockIds)) {
      throw new Error(`${label} returned no Page ids`);
    }
    expect(result.resultRootBlockIds).toHaveLength(batch.length);
    resultPageIds.push(
      ...result.resultRootBlockIds.map((value, index) =>
        requireString(value, `${label} Page id ${offset + index}`),
      ),
    );
  }
  return resultPageIds;
}

async function readConvergenceBoardTotal(
  page: Page,
  project: ConvergenceProject,
  minimumCommitSeq?: number,
): Promise<number> {
  const snapshot = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(page, "database:view-groups:get", project.projectId, {
      databaseViewId: project.defaultDatabaseViewId,
      ...(minimumCommitSeq === undefined ? {} : { minimumCommitSeq }),
    }),
    "Read Board group totals",
  );
  if (typeof snapshot.totalRows !== "number") {
    throw new Error("Board group totals returned no total row count");
  }
  return snapshot.totalRows;
}

async function launchLargeContentFixtureApplication(): Promise<ElectronApplication> {
  return electron.launch({ args: [largeContentElectronMain] });
}

async function buildLargeContentFixture(outDir: string): Promise<string> {
  await build({
    root: largeContentFixtureRoot,
    base: "./",
    configFile: false,
    logLevel: "warn",
    resolve: rendererViteResolve,
    css: rendererViteCss,
    plugins: createRendererVitePlugins(),
    build: {
      outDir,
      emptyOutDir: true,
    },
  });
  return path.join(outDir, "index.html");
}

async function createFixtureWindow(
  application: ElectronApplication,
  fixtureUrl: string,
): Promise<{ page: Page; windowId: number }> {
  const windowOpened = application.waitForEvent("window");
  const windowId = await application.evaluate(async ({ BrowserWindow }) => {
    const fixtureWindow = new BrowserWindow({
      width: 1_200,
      height: 800,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await fixtureWindow.loadURL("about:blank");
    return fixtureWindow.id;
  });
  const page = await windowOpened;
  await page.addInitScript(() => {
    const state = { longTasks: [] as number[] };
    Object.defineProperty(window, "__nodexLargeContentPerformance", {
      configurable: true,
      value: state,
    });
    if (typeof PerformanceObserver === "undefined") return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: true });
  });
  await page.goto(fixtureUrl);
  await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.show(), windowId);
  return { page, windowId };
}

async function closeFixtureWindow(
  application: ElectronApplication,
  windowId: number,
): Promise<void> {
  await application.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(),
    windowId,
  );
}

async function waitForLargeContentScenario(
  page: Page,
  scenario: LargeContentScenario,
): Promise<void> {
  await page.locator(`[data-performance-surface="${scenario}"]`).waitFor();
  if (scenario === "workspace") {
    await page.locator('[aria-label="Source preview for large-source.txt"]').waitFor();
    return;
  }
  if (scenario === "markdown") {
    await page.getByText("Rich preview is unavailable for large Markdown files.").waitFor();
    await page.locator('[aria-label="Markdown source for large-source.md"]').waitFor();
    return;
  }
  if (scenario === "tool") {
    await page.locator('[aria-label="Raw large tool output"]').waitFor();
    return;
  }
  await page.getByText("[earlier output truncated]", { exact: false }).waitFor();
}

async function readTraceStream(session: CDPSession, stream: string): Promise<string> {
  let trace = "";
  let eof = false;
  while (!eof) {
    const chunk = (await session.send("IO.read", { handle: stream })) as {
      data?: string;
      eof?: boolean;
    };
    trace += chunk.data ?? "";
    eof = chunk.eof === true;
  }
  await session.send("IO.close", { handle: stream });
  return trace;
}

async function finishTrace(session: CDPSession): Promise<string> {
  const complete = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for the Chromium trace stream")),
      10_000,
    );
    session.once("Tracing.tracingComplete", async (event: { stream?: string }) => {
      clearTimeout(timeout);
      if (!event.stream) {
        reject(new Error("Chromium did not return a trace stream"));
        return;
      }
      try {
        resolve(await readTraceStream(session, event.stream));
      } catch (error) {
        reject(error);
      }
    });
  });
  await session.send("Tracing.end");
  return await complete;
}

function maxTraceRunTaskMs(trace: string): number {
  const parsed = JSON.parse(trace) as {
    traceEvents?: Array<{ name?: string; dur?: number }>;
  };
  let maximum = 0;
  for (const event of parsed.traceEvents ?? []) {
    if (event.name !== "RunTask" || typeof event.dur !== "number") continue;
    maximum = Math.max(maximum, event.dur / 1_000);
  }
  return maximum;
}

async function sampleLargeContentScenario(input: {
  application: ElectronApplication;
  artifactDir: string;
  fixtureFile: string;
  scenario: LargeContentScenario;
}): Promise<LargeContentScenarioMetrics> {
  const fixtureUrl = new URL(pathToFileURL(input.fixtureFile));
  fixtureUrl.searchParams.set("scenario", input.scenario);
  const { page, windowId } = await createFixtureWindow(input.application, fixtureUrl.href);
  try {
    await page.locator('[aria-label="Warm viewport reader"]').waitFor();

    // Warm the exact component tree and all lazy chunks once, then remount from a
    // clean surface so the sample measures steady-state user-visible work.
    await page.locator(`[data-run-scenario="${input.scenario}"]`).click();
    await waitForLargeContentScenario(page, input.scenario);
    await page
      .locator("[data-reset-scenario]")
      .evaluate((element: HTMLButtonElement) => element.click());
    await page.locator('[aria-label="Warm viewport reader"]').waitFor();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Tracing.start", {
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "blink.user_timing",
      ].join(","),
      transferMode: "ReturnAsStream",
    });
    await page.evaluate(() => {
      const state = (
        window as unknown as {
          __nodexLargeContentPerformance: { longTasks: number[] };
        }
      ).__nodexLargeContentPerformance;
      state.longTasks.length = 0;
    });

    await page.locator(`[data-run-scenario="${input.scenario}"]`).click();
    await waitForLargeContentScenario(page, input.scenario);
    await page.waitForTimeout(300);

    const rendererMetrics = await page.evaluate(() => {
      const state = (
        window as unknown as {
          __nodexLargeContentPerformance: { longTasks: number[] };
        }
      ).__nodexLargeContentPerformance;
      return {
        domNodes: document.getElementsByTagName("*").length,
        maxLongTaskMs: Math.max(0, ...state.longTasks),
      };
    });
    const trace = await finishTrace(cdp);
    await cdp.send("Accessibility.enable");
    const accessibilityTree = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes?: unknown[];
    };
    await cdp.send("Accessibility.disable");

    const traceFileName = `${input.scenario}-trace.json`;
    const tracePath = path.join(input.artifactDir, traceFileName);
    fs.writeFileSync(tracePath, trace);
    const traceBytes = Buffer.byteLength(trace);
    const traceSha256 = createHash("sha256").update(trace).digest("hex");
    return {
      scenario: input.scenario,
      ...rendererMetrics,
      traceMaxRunTaskMs: maxTraceRunTaskMs(trace),
      accessibilityNodes: accessibilityTree.nodes?.length ?? 0,
      tracePath,
      traceBytes,
      traceSha256,
    };
  } finally {
    await closeFixtureWindow(input.application, windowId);
  }
}

test.describe("parallel functional Electron smoke", () => {
  test.describe.configure({ mode: process.env.CI ? "parallel" : "default" });

  test("preserves a structural clipboard capability through native paste", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "structural-clipboard-paste" });
    const digest = "a".repeat(64);
    try {
      const page = await harness.launch();
      const savedClipboard = await harness.application.evaluate(({ clipboard }) => ({
        html: clipboard.readHTML(),
        text: clipboard.readText(),
      }));
      try {
        const writeClaim = createUuidV7();
        const privateDescriptor = encodeNodexStructuralClipboardDescriptor({
          version: 1,
          phase: "preparing",
          writeClaim,
          actionHint: "copy",
        });
        await page.evaluate(
          (payload) => {
            const source = document.createElement("div");
            source.contentEditable = "true";
            source.textContent = payload.text;
            source.addEventListener(
              "copy",
              (event) => {
                event.clipboardData?.setData(payload.mime, payload.descriptor);
                event.clipboardData?.setData("text/html", payload.html);
                event.clipboardData?.setData("text/plain", payload.text);
                event.preventDefault();
              },
              { once: true },
            );
            document.body.append(source);
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(source);
            selection?.removeAllRanges();
            selection?.addRange(range);
            source.focus();
          },
          {
            mime: NODEX_STRUCTURAL_CLIPBOARD_MIME,
            descriptor: privateDescriptor,
            html: attachNodexStructuralClipboardWriteClaim("<p>Portable fallback</p>", writeClaim),
            text: "Portable fallback",
          },
        );
        await page.keyboard.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
        await page.evaluate((mime) => {
          const target = document.createElement("div");
          target.contentEditable = "true";
          target.dataset.structuralClipboardPreparingTarget = "true";
          target.addEventListener(
            "paste",
            (event) => {
              const clipboardEvent = event as ClipboardEvent;
              (
                window as unknown as {
                  __structuralClipboardPreparingPaste?: string;
                }
              ).__structuralClipboardPreparingPaste =
                clipboardEvent.clipboardData?.getData(mime) ?? "";
              event.preventDefault();
            },
            { once: true },
          );
          document.body.append(target);
          target.focus();
        }, NODEX_STRUCTURAL_CLIPBOARD_MIME);
        await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        await expect
          .poll(
            async () =>
              await page.evaluate(
                () =>
                  (
                    window as unknown as {
                      __structuralClipboardPreparingPaste?: string;
                    }
                  ).__structuralClipboardPreparingPaste ?? null,
              ),
          )
          .toBe(privateDescriptor);
        expect(
          await harness.application.evaluate(
            ({ clipboard }, mime) => clipboard.availableFormats().includes(mime),
            NODEX_STRUCTURAL_CLIPBOARD_MIME,
          ),
        ).toBe(true);
        await page.evaluate(() => {
          document
            .querySelector<HTMLElement>("[data-structural-clipboard-preparing-target]")
            ?.remove();
        });
        expect(
          await invokeIpc(page, "clipboard:structural-begin", {
            writeClaim,
            actionHint: "copy",
            libraryId: "library:e2e",
            storeEpoch: "epoch:e2e",
          }),
        ).toEqual({ ok: true });
        expect(
          await invokeIpc(page, "clipboard:structural-publish", {
            envelope: {
              version: 1,
              profileId: "profile:e2e",
              libraryId: "library:e2e",
              storeEpoch: "epoch:e2e",
              bundleId: "bundle:e2e",
              capability: digest,
              manifestHash: digest,
              actionHint: "copy",
            },
            writeClaim,
            html: "<p>Portable fallback</p>",
            text: "Portable fallback",
          }),
        ).toEqual({ ok: true });

        await page.evaluate(() => {
          const target = document.createElement("div");
          target.contentEditable = "true";
          target.dataset.structuralClipboardTarget = "true";
          target.addEventListener("paste", (event) => {
            const clipboardEvent = event as ClipboardEvent;
            (
              window as unknown as {
                __structuralClipboardPaste?: { html: string; text: string };
              }
            ).__structuralClipboardPaste = {
              html: clipboardEvent.clipboardData?.getData("text/html") ?? "",
              text: clipboardEvent.clipboardData?.getData("text/plain") ?? "",
            };
            event.preventDefault();
          });
          document.body.append(target);
          target.focus();
        });
        await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

        await expect
          .poll(
            async () =>
              await page.evaluate(
                () =>
                  (
                    window as unknown as {
                      __structuralClipboardPaste?: { html: string; text: string };
                    }
                  ).__structuralClipboardPaste ?? null,
              ),
          )
          .toMatchObject({ text: "Portable fallback" });
        const pasted = await page.evaluate(
          () =>
            (
              window as unknown as {
                __structuralClipboardPaste?: { html: string; text: string };
              }
            ).__structuralClipboardPaste,
        );
        expect(pasted?.html).toContain('name="nodex-clipboard-envelope-v1"');
        expect(pasted?.html).toContain("Portable fallback");
      } finally {
        await harness.application.evaluate(({ clipboard }, saved) => {
          clipboard.write({ html: saved.html, text: saved.text });
        }, savedClipboard);
      }
    } finally {
      await harness.close();
    }
  });

  for (const command of ["copy", "cut"] as const) {
    test(`preserves mouse-selected nested Images through local-path ${command} and native paste`, async () => {
      test.setTimeout(180_000);
      const harness = await ElectronScenarioHarness.create({ label: "image-hierarchy-clipboard" });
      const workspace = harness.profile.initialProjectsDirectory;
      try {
        const page = await harness.launch();
        const project = await createConvergenceProject(
          page,
          "Image hierarchy clipboard",
          workspace,
        );
        const source = await createConvergenceBoardPage(
          page,
          project,
          "Image hierarchy source",
          "Source body",
        );
        const target = await createConvergenceBoardPage(
          page,
          project,
          "Image hierarchy target",
          "Target body",
        );
        const operationId = createUuidV7();
        const fileId = createUuidV7();
        const prepared = await page.evaluate(
          async ({ projectId, operationId }) => {
            const bytes = Uint8Array.from(
              atob(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              ),
              (value) => value.charCodeAt(0),
            );
            return await window.api!.invoke(
              "page-files:prepare",
              { kind: "project", projectId },
              {
                operationId,
                source: { kind: "bytes", logicalPath: "image.png", mimeType: "image/png", bytes },
              },
            );
          },
          { projectId: project.projectId, operationId },
        );
        if (!isRecord(prepared)) throw new Error("Missing prepared image");
        const manifest = await readConvergencePageFiles(page, project.projectId, source.pageId);
        requireIpcValue(
          await invokeIpc(
            page,
            "library-module:apply",
            { kind: "project", projectId: project.projectId },
            {
              operationId,
              storeEpoch: project.storeEpoch,
              operation: {
                kind: "apply_page_file_changes",
                pageId: source.pageId,
                expectedManifestRevision: manifest.revision,
                changes: [
                  {
                    kind: "create",
                    fileId,
                    logicalPath: "image.png",
                    mimeType: "image/png",
                    preparedBlobReceiptId: requireString(prepared.receiptId, "Image receipt"),
                    collisionPolicy: "suffix",
                  },
                ],
              },
            },
          ),
          "Create image Files",
        );
        await page.evaluate(() =>
          localStorage.setItem("nodex-copy-file-references-as-local-paths-v1", "true"),
        );
        const seeded = await seedConvergenceDocument(
          page,
          project,
          source,
          [
            "Parent",
            "\tParent child",
            `\t<image source="nodex://files/${fileId}">One</image>`,
            `\t<image source="nodex://files/${fileId}">Two</image>`,
            "\tAfter child",
            "After root",
            "\tAfter root child",
            "Tail",
          ].join("\n"),
        );
        const targetSeeded = await seedConvergenceDocument(
          page,
          project,
          target,
          "Target before\n\nTarget after",
        );
        const savedClipboard = await harness.application.evaluate(({ clipboard }) => ({
          html: clipboard.readHTML(),
          text: clipboard.readText(),
        }));

        try {
          await page.setViewportSize({ width: 1400, height: 2400 });
          await page
            .getByRole("button", { name: "Open Image hierarchy clipboard", exact: true })
            .click();
          await page.getByRole("tab", { name: "Project Home" }).waitFor();
          const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
          await expect(board).toBeVisible({ timeout: 15_000 });
          await openBoardPageFromCard({
            card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
            page,
            tabName: "Image hierarchy source",
          });

          const sourcePanel = page.getByRole("tabpanel", { name: /Image hierarchy source$/ });
          const sourceEditor = sourcePanel.locator(
            '.nfm-editor .ProseMirror[contenteditable="true"]',
          );
          await expect(sourceEditor).toBeVisible({ timeout: 15_000 });
          const firstInline = sourceEditor
            .locator(`.bn-block[data-id="${seeded.blockIds[0]}"]`)
            .locator(":scope > .bn-block-content .bn-inline-content");
          const afterChild = sourceEditor.getByText("After child", { exact: true });
          const start = await firstInline.boundingBox();
          const end = await afterChild.boundingBox();
          if (!start || !end) throw new Error("Missing clipboard selection endpoints");
          await page.mouse.move(start.x + 1, start.y + start.height / 2);
          await page.mouse.down();
          try {
            await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 20 });
          } finally {
            await page.mouse.up();
          }
          expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
            "After child",
          );
          await page.keyboard.press(
            `${process.platform === "darwin" ? "Meta" : "Control"}+${command === "copy" ? "C" : "X"}`,
          );
          await expect
            .poll(() => harness.application.evaluate(({ clipboard }) => clipboard.readText()))
            .toContain("![One](/");
          expect(
            await harness.application.evaluate(({ clipboard }) => clipboard.availableFormats()),
          ).toContain("blocknote/html");
          await expect(
            sourceEditor.locator('.bn-block-content[data-content-type="image"]'),
          ).toHaveCount(command === "copy" ? 2 : 0);

          await openBoardPageFromCard({
            card: board.locator(`[data-board-uuid-v7="${target.pageId}"]`),
            page,
            tabName: "Image hierarchy target",
          });
          const targetPanel = page.getByRole("tabpanel", { name: /Image hierarchy target$/ });
          const targetEditor = targetPanel.locator(
            '.nfm-editor .ProseMirror[contenteditable="true"]',
          );
          const emptyTarget = targetEditor.locator(
            `.bn-block[data-id="${targetSeeded.blockIds[1]}"]`,
          );
          await emptyTarget.click();
          await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
          await page.keyboard.press("Enter");
          await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+V`);
          await expect(targetEditor.getByText("Parent child", { exact: true })).toBeVisible({
            timeout: 15_000,
          });

          const hierarchy = await targetEditor.evaluate((editor) => {
            const records = Array.from(editor.querySelectorAll<HTMLElement>(".bn-block-outer")).map(
              (outer) => {
                const block = outer.querySelector<HTMLElement>(":scope > .bn-block");
                const content = block?.querySelector<HTMLElement>(":scope > .bn-block-content");
                const inline = content?.querySelector<HTMLElement>(":scope > .bn-inline-content");
                return {
                  id: block?.dataset.id ?? null,
                  parentId:
                    outer.parentElement?.closest<HTMLElement>(".bn-block-outer")?.dataset.id ??
                    null,
                  type: block?.dataset.contentType ?? content?.dataset.contentType ?? null,
                  text: inline?.textContent ?? "",
                };
              },
            );
            const idForText = (text: string) =>
              records.find((record) => record.text === text)?.id ?? null;
            const copiedParentId = idForText("Parent");
            return {
              records,
              copiedParentId,
              parentChildParentId:
                records.find((record) => record.text === "Parent child")?.parentId ?? null,
              afterChildParentId:
                records.find((record) => record.text === "After child")?.parentId ?? null,
              imageParentIds: records
                .filter((record) => record.type === "image")
                .map((record) => record.parentId),
            };
          });
          expect(hierarchy).toEqual({
            copiedParentId: expect.any(String),
            parentChildParentId: hierarchy.copiedParentId,
            afterChildParentId: hierarchy.copiedParentId,
            imageParentIds: [hierarchy.copiedParentId, hierarchy.copiedParentId],
            records: expect.any(Array),
          });
        } finally {
          await harness.application.evaluate(({ clipboard }, saved) => {
            clipboard.write({ html: saved.html, text: saved.text });
          }, savedClipboard);
        }
      } finally {
        await harness.close();
      }
    });
  }

  test("deletes, copies, pastes, and restores a mixed subpage selection", async () => {
    test.setTimeout(180_000);
    const harness = await ElectronScenarioHarness.create({ label: "structural-subpage-edit" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Structural subpage edit", workspace);
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Structural source",
        "Source body",
      );
      const target = await createConvergenceBoardPage(
        page,
        project,
        "Structural target",
        "Target body",
      );
      const seeded = await seedConvergenceDocument(page, project, source, "before\nafter");
      const subpage = await createConvergenceSubpage(
        page,
        project,
        source,
        "abc",
        seeded.blockIds[1],
      );
      await seedConvergenceDocument(page, project, subpage, "abc owned body\nabc owned tail");
      const targetSeeded = await seedConvergenceDocument(
        page,
        project,
        target,
        "target before\ntarget after",
      );
      const nestedTarget = await createConvergenceSubpage(
        page,
        project,
        target,
        "Nested target",
        targetSeeded.blockIds[1],
      );
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.getByRole("button", { name: "Open Structural subpage edit", exact: true }).click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(board).toBeVisible({ timeout: 15_000 });
      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        page,
        tabName: "Structural source",
      });

      const sourcePanel = page.getByRole("tabpanel", { name: /Structural source$/ });
      const sourceEditor = sourcePanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const before = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[0]}"]`);
      const owner = sourceEditor.locator(`.bn-block[data-id="${subpage.pageId}"]`);
      const after = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[1]}"]`);
      await expect(owner).toBeVisible({ timeout: 15_000 });

      await owner.getByRole("button", { name: "Edit abc title" }).click();
      const ownerTitle = owner.getByRole("textbox", { name: "Edit abc title" });
      await expect(ownerTitle).toBeFocused();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
      await expect
        .poll(
          async () =>
            await ownerTitle.evaluate((title) => {
              const selection = window.getSelection();
              const containsPoint = (node: Node | null) =>
                node === title || Boolean(node && title.contains(node));
              return {
                anchorInside: containsPoint(selection?.anchorNode ?? null),
                focusInside: containsPoint(selection?.focusNode ?? null),
                text: selection?.toString() ?? "",
              };
            }),
        )
        .toEqual({ anchorInside: true, focusInside: true, text: "abc" });

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+A`);
      const promotedSelection = await sourceEditor.evaluate((editor) => {
        const selection = window.getSelection();
        const title = editor.querySelector<HTMLElement>("[data-editor-select-all-scope='leaf']");
        const containsPoint = (node: Node | null) =>
          Boolean(title && (node === title || (node && title.contains(node))));
        const selectedText = selection?.toString() ?? "";
        return {
          confinedToTitle:
            containsPoint(selection?.anchorNode ?? null) &&
            containsPoint(selection?.focusNode ?? null),
          includesBeforeBlock: selectedText.includes("before"),
          includesAfterBlock: selectedText.includes("after"),
        };
      });
      expect(promotedSelection).toEqual({
        confinedToTitle: false,
        includesBeforeBlock: true,
        includesAfterBlock: true,
      });

      const afterInline = after.locator(":scope > .bn-block-content .bn-inline-content");
      const afterInlineBox = await afterInline.boundingBox();
      if (!afterInlineBox) throw new Error("The paragraph after the subpage has no layout box");
      await afterInline.click({ position: { x: 1, y: afterInlineBox.height / 2 } });
      await page.keyboard.press("Backspace");
      await expect(owner).toBeVisible();
      await expect
        .poll(async () => ({
          focusedBlockId: await sourceEditor.evaluate(() => {
            const selection = window.getSelection();
            const node = selection?.focusNode;
            const element = node instanceof Element ? node : node?.parentElement;
            return element?.closest<HTMLElement>(".bn-block[data-id]")?.dataset.id ?? null;
          }),
          before: seeded.blockIds[0],
          owner: subpage.pageId,
          after: seeded.blockIds[1],
        }))
        .toEqual({
          focusedBlockId: seeded.blockIds[0],
          before: seeded.blockIds[0],
          owner: subpage.pageId,
          after: seeded.blockIds[1],
        });
      await expect(
        page.getByText("Nodex blocked an incomplete structural change.", { exact: false }),
      ).toHaveCount(0);
      await expect(after).toHaveCount(0);
      await expect(before).toContainText("beforeafter");
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(after).toBeVisible({ timeout: 15_000 });
      await expect(before).toHaveText("before");

      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: before,
        lastBlock: after,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+C`);
      await afterInline.click();
      await page.keyboard.press("End");
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+V`);
      const samePageClone = sourceEditor
        .locator(".bn-block[data-id]")
        .filter({ hasText: "abc (1)" });
      await expect(samePageClone).toHaveCount(1, { timeout: 15_000 });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(samePageClone).toHaveCount(0, { timeout: 15_000 });

      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: before,
        lastBlock: after,
      });
      await page.keyboard.press("Backspace");
      await expect(owner).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(
          async () =>
            await sourceEditor.evaluate((editor) => editor.contains(document.activeElement)),
        )
        .toBe(true);

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(owner).toBeVisible({ timeout: 15_000 });
      await expect(before).toBeVisible();
      await expect(after).toBeVisible();

      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: before,
        lastBlock: after,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+C`);
      await expect
        .poll(
          async () =>
            await harness.application.evaluate(({ clipboard }) =>
              clipboard.readHTML().includes('name="nodex-clipboard-envelope-v1"'),
            ),
        )
        .toBe(true);

      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${target.pageId}"]`),
        page,
        tabName: "Structural target",
      });
      const targetPanel = page.getByRole("tabpanel", { name: /Structural target$/ });
      const targetEditor = targetPanel
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]')
        .first();
      await expect(targetEditor).toBeVisible({ timeout: 15_000 });
      const nestedTargetOwner = targetEditor.locator(`.bn-block[data-id="${nestedTarget.pageId}"]`);
      await expect(nestedTargetOwner).toBeVisible({ timeout: 15_000 });
      await nestedTargetOwner.getByRole("button", { name: "Expand Nested target" }).click();
      const nestedTargetEditor = nestedTargetOwner
        .locator('[data-page-outliner-body] .nfm-editor .ProseMirror[contenteditable="true"]')
        .first();
      await expect(nestedTargetEditor).toBeVisible({ timeout: 15_000 });
      await nestedTargetEditor.click();
      await page.keyboard.press("End");
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+V`);
      const clonedOwner = nestedTargetEditor
        .locator(".bn-block[data-id]")
        .filter({ hasText: "abc (1)" });
      await expect(clonedOwner).toHaveCount(1, { timeout: 15_000 });
      const expandClonedOwner = clonedOwner.getByRole("button", { name: "Expand abc (1)" });
      await expect(expandClonedOwner).toBeVisible();
      await expandClonedOwner.click();
      await expect(clonedOwner.getByText("abc owned body", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect
        .poll(
          async () =>
            await nestedTargetEditor.evaluate((editor) => editor.contains(document.activeElement)),
        )
        .toBe(true);

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(clonedOwner).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByRole("alert").filter({ hasText: "Something went wrong" })).toHaveCount(
        0,
      );
      expect(pageErrors.filter((message) => message.includes("Block doesn't have id"))).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test("turns a mixed subpage selection into content and restores it", async () => {
    test.setTimeout(180_000);
    const harness = await ElectronScenarioHarness.create({ label: "subpage-turn-into" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Subpage turn into", workspace);
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Turn into source",
        "Page containing the Turn into fixture",
      );
      const seeded = await seedConvergenceDocument(page, project, source, "before\nafter");
      const subpage = await createConvergenceSubpage(
        page,
        project,
        source,
        "Owned details",
        seeded.blockIds[1],
      );
      const subpageBody = await seedConvergenceDocument(
        page,
        project,
        subpage,
        "owned body\nowned tail",
      );
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.getByRole("button", { name: "Open Subpage turn into", exact: true }).click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(board).toBeVisible({ timeout: 15_000 });
      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        page,
        tabName: "Turn into source",
      });

      const sourcePanel = page.getByRole("tabpanel", { name: /Turn into source$/ });
      const sourceEditor = sourcePanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const before = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[0]}"]`);
      const owner = sourceEditor.locator(`.bn-block[data-id="${subpage.pageId}"]`);
      const after = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[1]}"]`);
      await expect(owner).toBeVisible({ timeout: 15_000 });

      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: before,
        lastBlock: after,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+/`);
      await page.getByRole("dialog", { name: "Block actions" }).waitFor();
      await page.getByRole("option", { name: /^Turn into/ }).click();
      const turnIntoMenu = page.getByRole("dialog", { name: "Turn into" });
      await turnIntoMenu.waitFor();
      await turnIntoMenu.getByRole("menuitem", { name: "Toggle list" }).click();

      const turnedOwner = sourceEditor.locator(`.bn-block[data-id="${subpage.pageId}"]`);
      await expect(
        turnedOwner.locator(':scope > .bn-block-content[data-content-type="toggleListItem"]'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        before.locator(':scope > .bn-block-content[data-content-type="toggleListItem"]'),
      ).toBeVisible();
      await expect(
        after.locator(':scope > .bn-block-content[data-content-type="toggleListItem"]'),
      ).toBeVisible();
      const turnedOwnerTree = sourceEditor.locator(`.bn-block-outer[data-id="${subpage.pageId}"]`);
      for (const bodyBlockId of subpageBody.blockIds) {
        await expect(turnedOwnerTree.locator(`.bn-block[data-id="${bodyBlockId}"]`)).toHaveCount(1);
      }
      await expect
        .poll(async () =>
          sourceEditor.evaluate((editor) => editor.contains(document.activeElement)),
        )
        .toBe(true);

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      const restoredOwner = sourceEditor.locator(`.bn-block[data-id="${subpage.pageId}"]`);
      await expect(
        restoredOwner.getByRole("button", { name: "Edit Owned details title" }),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        before.locator(':scope > .bn-block-content[data-content-type="paragraph"]'),
      ).toBeVisible();
      await expect(
        after.locator(':scope > .bn-block-content[data-content-type="paragraph"]'),
      ).toBeVisible();
      await restoredOwner.getByRole("button", { name: "Expand Owned details" }).click();
      await expect(restoredOwner.getByText("owned body", { exact: true })).toBeVisible({
        timeout: 15_000,
      });

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+Z`);
      await expect(
        sourceEditor
          .locator(`.bn-block[data-id="${subpage.pageId}"]`)
          .locator(':scope > .bn-block-content[data-content-type="toggleListItem"]'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test("pastes a mixed subpage selection after both Page Stage tabs remount", async () => {
    test.setTimeout(180_000);
    const harness = await ElectronScenarioHarness.create({ label: "structural-retained-paste" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Retained structural paste", workspace);
      const parent = await createConvergenceBoardPage(
        page,
        project,
        "Retained parent",
        "Parent body",
      );
      const parentSeeded = await seedConvergenceDocument(
        page,
        project,
        parent,
        "source before\nsource after\nsource tail",
      );
      const copiedSubpage = await createConvergenceSubpage(
        page,
        project,
        parent,
        "Retained child A",
        parentSeeded.blockIds[1],
      );
      const targetSubpage = await createConvergenceSubpage(
        page,
        project,
        parent,
        "Retained child B",
        parentSeeded.blockIds[2],
      );
      await seedConvergenceDocument(
        page,
        project,
        copiedSubpage,
        "retained owned body\nretained owned tail",
      );
      const targetSeeded = await seedConvergenceDocument(
        page,
        project,
        targetSubpage,
        "target before\ntarget after",
      );

      await page
        .getByRole("button", { name: "Open Retained structural paste", exact: true })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${parent.pageId}"]`),
        page,
        tabName: "Retained parent",
      });

      const parentPanel = page.getByRole("tabpanel", { name: /Retained parent$/ });
      const parentEditor = parentPanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const copiedOwner = parentEditor.locator(`.bn-block[data-id="${copiedSubpage.pageId}"]`);
      const targetOwner = parentEditor.locator(`.bn-block[data-id="${targetSubpage.pageId}"]`);
      await expect(copiedOwner).toBeVisible({ timeout: 15_000 });
      await targetOwner.hover();
      await targetOwner.getByRole("button", { name: "Open Retained child B" }).click();
      await page.getByRole("tab", { name: "Retained child B" }).waitFor();
      await expect(
        page
          .getByRole("tabpanel", { name: /Retained child B$/ })
          .locator('.nfm-editor .ProseMirror[contenteditable="true"]'),
      ).toBeVisible({ timeout: 15_000 });

      await page.getByRole("tab", { name: "Retained parent" }).click();
      await expect(parentEditor).toBeVisible({ timeout: 15_000 });
      const before = parentEditor.locator(`.bn-block[data-id="${parentSeeded.blockIds[0]}"]`);
      const after = parentEditor.locator(`.bn-block[data-id="${parentSeeded.blockIds[1]}"]`);
      await selectEditorBlockRange({
        page,
        editor: parentEditor,
        firstBlock: before,
        lastBlock: after,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+C`);
      await page.getByRole("tab", { name: "Retained child B" }).click();
      const targetPanel = page.getByRole("tabpanel", { name: /Retained child B$/ });
      const targetEditor = targetPanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await expect(targetEditor).toBeVisible({ timeout: 15_000 });
      await targetEditor.locator(`.bn-block[data-id="${targetSeeded.blockIds[0]}"]`).click();
      await page.keyboard.press("End");
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+V`);

      const clonedOwner = targetEditor.locator(".bn-block[data-id]").filter({
        hasText: "Retained child A (1)",
      });
      await expect(clonedOwner).toHaveCount(1, { timeout: 15_000 });
      await clonedOwner.getByRole("button", { name: "Expand Retained child A (1)" }).click();
      await expect(clonedOwner.getByText("retained owned body", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect
        .poll(
          async () =>
            await harness.application.evaluate(({ clipboard }) => ({
              html: clipboard.readHTML(),
              text: clipboard.readText(),
            })),
        )
        .toMatchObject({
          html: expect.stringContaining('name="nodex-clipboard-envelope-v1"'),
          text: expect.stringContaining(copiedSubpage.pageId),
        });
      await expect(
        page.getByText("This structural content is still preparing.", { exact: false }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Structural editing is initializing.", { exact: false }),
      ).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });

  test("keeps consecutive subpage cuts available for nested paste", async () => {
    test.setTimeout(180_000);
    const harness = await ElectronScenarioHarness.create({ label: "structural-consecutive-cut" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Structural consecutive cut", workspace);
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Consecutive cut source",
        "Source body",
      );
      const target = await createConvergenceBoardPage(
        page,
        project,
        "Consecutive cut target",
        "Target body",
      );
      const seeded = await seedConvergenceDocument(
        page,
        project,
        source,
        "before one\nafter one\nbefore two\nafter two",
      );
      const firstSubpage = await createConvergenceSubpage(
        page,
        project,
        source,
        "Cut one",
        seeded.blockIds[1],
      );
      const secondSubpage = await createConvergenceSubpage(
        page,
        project,
        source,
        "Cut two",
        seeded.blockIds[3],
      );
      await seedConvergenceDocument(page, project, firstSubpage, "first owned body\nfirst tail");
      await seedConvergenceDocument(page, project, secondSubpage, "second owned body\nsecond tail");
      const targetSeeded = await seedConvergenceDocument(
        page,
        project,
        target,
        "target before\ntarget after",
      );
      const nestedTarget = await createConvergenceSubpage(
        page,
        project,
        target,
        "Nested cut target",
        targetSeeded.blockIds[1],
      );

      await page
        .getByRole("button", { name: "Open Structural consecutive cut", exact: true })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        page,
        tabName: "Consecutive cut source",
      });

      const sourcePanel = page.getByRole("tabpanel", { name: /Consecutive cut source$/ });
      const sourceEditor = sourcePanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const firstOwner = sourceEditor.locator(`.bn-block[data-id="${firstSubpage.pageId}"]`);
      const secondOwner = sourceEditor.locator(`.bn-block[data-id="${secondSubpage.pageId}"]`);
      const beforeFirst = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[0]}"]`);
      const afterFirst = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[1]}"]`);
      const beforeSecond = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[2]}"]`);
      const afterSecond = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[3]}"]`);
      await expect(firstOwner).toBeVisible({ timeout: 15_000 });
      await expect(secondOwner).toBeVisible();

      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: beforeFirst,
        lastBlock: afterFirst,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+X`);
      await expect(firstOwner).toHaveCount(0, { timeout: 15_000 });

      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: beforeSecond,
        lastBlock: afterSecond,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+X`);
      await expect(secondOwner).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.getByText("Nodex blocked an incomplete structural change.", { exact: false }),
      ).toHaveCount(0);

      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${target.pageId}"]`),
        page,
        tabName: "Consecutive cut target",
      });
      const targetPanel = page.getByRole("tabpanel", { name: /Consecutive cut target$/ });
      const targetEditor = targetPanel
        .locator('.nfm-editor .ProseMirror[contenteditable="true"]')
        .first();
      const nestedTargetOwner = targetEditor.locator(`.bn-block[data-id="${nestedTarget.pageId}"]`);
      await nestedTargetOwner.getByRole("button", { name: "Expand Nested cut target" }).click();
      const nestedTargetEditor = nestedTargetOwner.locator(
        '[data-page-outliner-body] .nfm-editor .ProseMirror[contenteditable="true"]',
      );
      await expect(nestedTargetEditor).toBeVisible({ timeout: 15_000 });
      await nestedTargetEditor.click();
      await page.keyboard.press("End");
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+V`);

      const expandMovedOwner = nestedTargetEditor.getByRole("button", { name: "Expand Cut two" });
      await expect(expandMovedOwner).toBeVisible({ timeout: 15_000 });
      await expandMovedOwner.click();
      await expect(nestedTargetEditor.getByText("second owned body", { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText("This structural content is still preparing.", { exact: false }),
      ).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });

  test("moves a cut subpage across Pages and restores it from target history", async () => {
    test.setTimeout(150_000);
    const harness = await ElectronScenarioHarness.create({ label: "structural-subpage-cut" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Structural subpage cut", workspace);
      const source = await createConvergenceBoardPage(page, project, "Cut source", "Source body");
      const target = await createConvergenceBoardPage(page, project, "Cut target", "Target body");
      const seeded = await seedConvergenceDocument(page, project, source, "before\nafter");
      const subpage = await createConvergenceSubpage(
        page,
        project,
        source,
        "abc",
        seeded.blockIds[1],
      );

      await page.getByRole("button", { name: "Open Structural subpage cut", exact: true }).click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(board).toBeVisible({ timeout: 15_000 });
      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        page,
        tabName: "Cut source",
      });

      const sourcePanel = page.getByRole("tabpanel", { name: /Cut source$/ });
      const sourceEditor = sourcePanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const before = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[0]}"]`);
      const owner = sourceEditor.locator(`.bn-block[data-id="${subpage.pageId}"]`);
      const after = sourceEditor.locator(`.bn-block[data-id="${seeded.blockIds[1]}"]`);
      await expect(owner).toBeVisible({ timeout: 15_000 });
      const clipboardBefore = await harness.application.evaluate(({ clipboard }) =>
        clipboard.readHTML(),
      );
      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: before,
        lastBlock: after,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+X`);
      await expect(owner).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(
          async () =>
            await harness.application.evaluate(({ clipboard }, previous) => {
              const html = clipboard.readHTML();
              return html !== previous && html.includes('name="nodex-clipboard-envelope-v1"');
            }, clipboardBefore),
        )
        .toBe(true);

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(owner).toBeVisible({ timeout: 15_000 });
      const firstCutClipboard = await harness.application.evaluate(({ clipboard }) =>
        clipboard.readHTML(),
      );
      await selectEditorBlockRange({
        page,
        editor: sourceEditor,
        firstBlock: before,
        lastBlock: after,
      });
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+X`);
      await expect(owner).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(
          async () =>
            await harness.application.evaluate(({ clipboard }, previous) => {
              const html = clipboard.readHTML();
              return html !== previous && html.includes('name="nodex-clipboard-envelope-v1"');
            }, firstCutClipboard),
        )
        .toBe(true);

      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${target.pageId}"]`),
        page,
        tabName: "Cut target",
      });
      const targetPanel = page.getByRole("tabpanel", { name: /Cut target$/ });
      const targetEditor = targetPanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await expect(targetEditor).toBeVisible({ timeout: 15_000 });
      await targetEditor.click();
      await page.keyboard.press("End");
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+V`);
      const pastedOwner = targetEditor.locator(".bn-block[data-id]").filter({ hasText: /abc/ });
      await expect(pastedOwner).toHaveCount(1, { timeout: 15_000 });
      await expect(pastedOwner).toHaveAttribute("data-id", subpage.pageId);
      await expect(page.getByRole("alert")).toHaveCount(0);
      const movedOwner = targetEditor.locator(`.bn-block[data-id="${subpage.pageId}"]`);

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(movedOwner).toHaveCount(0, { timeout: 15_000 });
      await page.getByRole("tab", { name: "Cut source" }).click();
      await expect(owner).toBeVisible({ timeout: 15_000 });
    } finally {
      await harness.close();
    }
  });

  test("provisions and persists the initial source-backed Project across a full Electron restart", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({
      label: "initial-project-restart",
    });
    const { initialProjectsDirectory: projectsDirectory, nodexHome } = harness.profile;
    try {
      const firstWindow = await harness.launch();

      await expect
        .poll(async () => {
          return await firstWindow.evaluate(async () => {
            const projects = (await window.api?.invoke("projects:list")) as
              | {
                  items?: unknown[];
                }
              | undefined;
            return projects?.items?.length ?? 0;
          });
        })
        .toBe(1);
      await expect(
        firstWindow.getByRole("heading", {
          name: "Select a project",
        }),
      ).toHaveCount(0);

      const firstState = await firstWindow.evaluate(async () => {
        const projects = (await window.api?.invoke("projects:list")) as
          | {
              items?: Array<{
                id: string;
                name: string;
                primaryWorkspaceRoot: string | null;
              }>;
            }
          | undefined;
        const bootstrap = (await window.api?.invoke("window-sessions:bootstrap")) as
          | {
              session?: {
                layout?: {
                  location?: {
                    kind?: string;
                    projectId?: string;
                  };
                  scenesByOwnerKey?: Record<
                    string,
                    {
                      primary?: {
                        kind?: string;
                      };
                      panelSurfacesById?: Record<
                        string,
                        {
                          kind?: string;
                          config?: { pageId?: string };
                        }
                      >;
                      panels?: {
                        right?: {
                          collapsed?: boolean;
                          size?: { fullWidth?: boolean };
                          layout?: {
                            root?: { activeTabId?: string | null };
                          };
                        };
                      };
                    }
                  >;
                };
              };
            }
          | undefined;
        return { projects, bootstrap };
      });
      const createdProject = firstState.projects?.items?.[0];
      expect(createdProject).toMatchObject({ name: "My Project" });
      expect(createdProject?.primaryWorkspaceRoot).toBe(path.join(projectsDirectory, "My Project"));
      expect(fs.realpathSync(createdProject?.primaryWorkspaceRoot ?? "")).toBe(
        fs.realpathSync(path.join(projectsDirectory, "My Project")),
      );

      const layout = firstState.bootstrap?.session?.layout;
      expect(layout?.location).toMatchObject({
        kind: "project",
        projectId: createdProject?.id,
      });
      const projectScene = createdProject?.id
        ? layout?.scenesByOwnerKey?.[`project:${createdProject.id}`]
        : undefined;
      expect(projectScene?.primary?.kind).toBe("db_view");
      const surfaces = Object.values(projectScene?.panelSurfacesById ?? {});
      expect(surfaces.map((surface) => surface.kind)).toEqual(["page_stage"]);
      expect(projectScene?.panels?.right).toMatchObject({
        collapsed: false,
        size: { fullWidth: true },
      });
      const activeRightTabId = projectScene?.panels?.right?.layout?.root?.activeTabId;
      expect(
        activeRightTabId ? projectScene?.panelSurfacesById?.[activeRightTabId]?.kind : undefined,
      ).toBe("page_stage");
      const starterPageId = surfaces.find((surface) => surface.kind === "page_stage")?.config
        ?.pageId;
      expect(starterPageId).toBeTruthy();

      const pageDetail = await firstWindow.evaluate(
        async ({ projectId, pageId }) => {
          return await window.api?.invoke("pages:detail:get", projectId, pageId);
        },
        {
          projectId: createdProject?.id ?? "",
          pageId: starterPageId ?? "",
        },
      );
      expect(pageDetail).toMatchObject({
        ok: true,
        value: {
          page: {
            title: "Welcome to Nodex",
          },
          document: {
            readiness: "ready",
          },
        },
      });
      expect(
        (
          pageDetail as {
            value?: { page?: { plainText?: string } };
          }
        ).value?.page?.plainText,
      ).toContain("Connect your model");
      expect(
        (
          pageDetail as {
            value?: { page?: { plainText?: string } };
          }
        ).value?.page?.plainText,
      ).toContain(createdProject?.primaryWorkspaceRoot);

      expect(fs.existsSync(path.join(nodexHome, "recovery", "initial-project-v2.json"))).toBe(
        false,
      );
      expect(
        fs.existsSync(
          path.join(createdProject?.primaryWorkspaceRoot ?? "", ".nodex-initial-project-v2.json"),
        ),
      ).toBe(false);

      const restartedWindow = await harness.restart();

      const persisted = await restartedWindow.evaluate(async () => {
        const projects = await window.api?.invoke("projects:list");
        const bootstrap = await window.api?.invoke("window-sessions:bootstrap");
        return { projects, bootstrap };
      });
      expect(
        (
          persisted as {
            projects?: { items?: unknown[] };
          }
        ).projects?.items,
      ).toEqual([
        expect.objectContaining({
          id: createdProject?.id,
          name: "My Project",
          primaryWorkspaceRoot: createdProject?.primaryWorkspaceRoot,
        }),
      ]);
      expect(
        (
          persisted as {
            bootstrap?: { session?: { layout?: { location?: unknown } } };
          }
        ).bootstrap?.session?.layout?.location,
      ).toMatchObject({
        kind: "project",
        projectId: createdProject?.id,
      });
      await expect(
        restartedWindow.getByRole("heading", {
          name: "Select a project",
        }),
      ).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });

  test("New Chat reuses its default draft and opens a pre-thread Terminal", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "new-chat" });
    try {
      const page = await harness.launch();
      await expect
        .poll(async () => {
          const projects = (await invokeIpc(page, "projects:list")) as
            | {
                items?: unknown[];
              }
            | undefined;
          return projects?.items?.length ?? 0;
        })
        .toBe(1);
      const projects = (await invokeIpc(page, "projects:list")) as {
        items: Array<{
          id: string;
          primaryWorkspaceRoot: string | null;
        }>;
      };
      const project = projects.items[0];
      if (!project?.primaryWorkspaceRoot) {
        throw new Error("Initial Project workspace is unavailable");
      }

      const newChat = page.getByRole("button", { name: "New chat" }).first();
      await newChat.click();
      const readSessions = async () =>
        (
          (await invokeIpc(page, "workspace:tasks:list", project.id, { first: 50 })) as {
            items: Array<{ id: string; thread: unknown | null }>;
          }
        ).items;
      await expect.poll(async () => (await readSessions()).length).toBe(1);
      const firstSessionId = (await readSessions())[0]?.id;
      expect(firstSessionId).toBeTruthy();

      const prompt = page.locator('[contenteditable="true"][aria-label="Do anything"]');
      await prompt.fill("Keep this prepared prompt");
      await newChat.click();
      await expect(prompt).toHaveText("Keep this prepared prompt");
      const repeatedSessions = await readSessions();
      expect(repeatedSessions).toHaveLength(1);
      expect(repeatedSessions[0]?.id).toBe(firstSessionId);
      expect(repeatedSessions[0]?.thread).toBeNull();

      const bottomPanelToggle = page.getByRole("button", { name: "Toggle bottom panel" });
      await bottomPanelToggle.click();
      await expect(bottomPanelToggle).toHaveAttribute("aria-pressed", "true");
      const terminalSurface = page.locator(".xterm-screen").last();
      await expect(terminalSurface).toBeVisible();
      const terminalRows = page.locator(".xterm-rows").last();
      await expect
        .poll(async () => (await terminalRows.textContent())?.trim() ?? "", { timeout: 30_000 })
        .not.toBe("");
      await terminalSurface.click();
      const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
      await expect(terminalInput).toBeFocused();
      await page.keyboard.type("pwd", { delay: 20 });
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => (await terminalRows.textContent()) ?? "", { timeout: 30_000 })
        .toContain(project.primaryWorkspaceRoot);
    } finally {
      await harness.close();
    }
  });

  test("creates and draws in an inline Canvas without taking over the Page", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "canvas" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      await page.evaluate(
        async ({ name, source }) =>
          window.api?.invoke("projects:create", { name, sources: [source] }),
        { name: "Canvas workflow", source: workspace },
      );

      await page
        .getByRole("button", {
          name: "Open Canvas workflow",
          exact: true,
        })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      await page.getByRole("button", { name: "New Page or Database" }).click({
        force: true,
      });
      await page.getByRole("menuitem", { name: "Page" }).click();
      await page.getByRole("button", { name: "Page actions" }).waitFor();

      await page.getByRole("button", { name: "Actions for Untitled" }).last().click();
      await page.getByRole("menuitem", { name: "Open in Project…" }).click();
      await page.getByRole("button", { name: "Grant and open" }).click();

      const editor = page
        .locator('[data-page-stage-surface="true"]')
        .getByTestId("page-stage-scroll-container")
        .locator(".nfm-editor .ProseMirror[contenteditable=true]")
        .first();
      await editor.click();
      await page.keyboard.type("/canvas");
      await page.evaluate(() => {
        const state = window as typeof window & {
          __canvasPendingObserved?: boolean;
        };
        state.__canvasPendingObserved = false;
        const observer = new MutationObserver(() => {
          if (!document.querySelector("[data-canvas-create-pending]")) return;
          state.__canvasPendingObserved = true;
          observer.disconnect();
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      });
      await page.getByRole("option", { name: /Canvas/ }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as typeof window & {
                  __canvasPendingObserved?: boolean;
                }
              ).__canvasPendingObserved === true,
          ),
        )
        .toBe(true);
      const canvasBlock = page.locator("[data-canvas-block]").first();
      await expect(canvasBlock).toBeVisible({ timeout: 5_000 });
      await expect(canvasBlock).toHaveAttribute("data-canvas-block-active", "true", {
        timeout: 15_000,
      });
      await expect(canvasBlock.locator("[data-canvas-create-pending]")).toHaveCount(0);
      const boundary = canvasBlock.locator('[data-excalidraw-embed-boundary="inline"]');
      await expect(boundary.locator(".excalidraw")).toBeVisible();

      const pageActions = page.getByRole("button", { name: "Page actions" });
      const actionsBox = await pageActions.boundingBox();
      if (!actionsBox) throw new Error("Page actions have no layout box");
      const pageActionsHitBoundary = await page.evaluate(
        ({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return (
            hit
              ?.closest("[data-excalidraw-embed-boundary]")
              ?.getAttribute("data-excalidraw-embed-boundary") ?? null
          );
        },
        {
          x: actionsBox.x + actionsBox.width / 2,
          y: actionsBox.y + actionsBox.height / 2,
        },
      );
      expect(pageActionsHitBoundary).toBeNull();
      await pageActions.click();
      await page.keyboard.press("Escape");

      const canvasId = await canvasBlock.getAttribute("data-canvas-block");
      if (!canvasId) throw new Error("Canvas block has no owner identity");
      const readCanvasHead = async (): Promise<number> =>
        await page.evaluate(
          async ({ targetCanvasId }) => {
            const raw = (await window.api?.invoke(
              "library-module:read",
              { kind: "library" },
              {
                read: { mode: "canvas_target", canvasId: targetCanvasId },
              },
            )) as
              | {
                  ok?: boolean;
                  value?: {
                    value?: {
                      kind?: string;
                      value?: {
                        status?: string;
                        summary?: { documentHeadSeq?: number };
                      };
                    };
                  };
                }
              | undefined;
            const target = raw?.value?.value;
            if (
              !raw?.ok ||
              target?.kind !== "canvas_target" ||
              target.value?.status !== "available"
            ) {
              return -1;
            }
            return target.value.summary?.documentHeadSeq ?? -1;
          },
          {
            targetCanvasId: canvasId,
          },
        );
      const initialHead = await readCanvasHead();

      const rectangleTool = boundary.getByRole("radio", { name: /Rectangle/ });
      await rectangleTool.check({ force: true });
      const interactiveCanvas = boundary.locator("canvas.excalidraw__canvas.interactive");
      const canvasBox = await interactiveCanvas.boundingBox();
      if (!canvasBox) throw new Error("Interactive Canvas has no layout box");
      await page.mouse.move(
        canvasBox.x + canvasBox.width * 0.35,
        canvasBox.y + canvasBox.height * 0.55,
      );
      await page.mouse.down();
      await page.mouse.move(
        canvasBox.x + canvasBox.width * 0.55,
        canvasBox.y + canvasBox.height * 0.72,
        { steps: 5 },
      );
      await page.mouse.up();

      await expect.poll(readCanvasHead, { timeout: 10_000 }).toBeGreaterThan(initialHead);
    } finally {
      await harness.close();
    }
  });

  test("converges a Move to operation in the live standalone Pages projection", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "move-convergence" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();

      const project = await createConvergenceProject(page, "Move convergence", workspace);
      const source = await createConvergencePage(page, project, "Source Page");
      const target = await createConvergencePage(page, project, "Target Page");

      await page
        .getByRole("button", {
          name: "Open Move convergence",
          exact: true,
        })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      await page
        .getByRole("button", {
          name: "Actions for Source Page",
          exact: true,
        })
        .click();
      const moveItem = page.getByRole("menuitem", { name: "Move to", exact: true });
      await moveItem.focus();
      await page.keyboard.press("ArrowRight");
      const moveSearch = page.getByRole("combobox", { name: "Move Source Page to" });
      await expect(moveSearch).toBeVisible();
      await moveSearch.fill("Target Page");
      await page
        .locator('[role="option"]:not([aria-disabled="true"])')
        .filter({ hasText: "Target Page" })
        .first()
        .click();
      await expect(moveSearch).toBeHidden();

      // The source must disappear from the mounted sidebar without reopening the
      // Project or manually refreshing the Library.
      await expect
        .poll(
          async () =>
            await page
              .getByRole("button", {
                name: "Actions for Source Page",
                exact: true,
              })
              .count(),
          { timeout: 5_000 },
        )
        .toBe(0);
      await expect(
        page.getByRole("button", {
          name: "Actions for Target Page",
          exact: true,
        }),
      ).toBeVisible();

      const pathSnapshot = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(
          page,
          "library-module:read",
          { kind: "library" },
          {
            read: { mode: "path", target: { kind: "page", pageId: source.pageId } },
          },
        ),
        "Read moved Page path",
      );
      const pathValue = pathSnapshot.value;
      if (!isRecord(pathValue) || pathValue.kind !== "path" || !Array.isArray(pathValue.nodes)) {
        throw new Error("Moved Page path read returned an unexpected value");
      }
      expect(pathValue.nodes.map((node) => (isRecord(node) ? node.pageId : undefined))).toEqual([
        target.pageId,
        source.pageId,
      ]);
    } finally {
      await harness.close();
    }
  });

  test("creates one stable Board Page and edits its grouping Property @create-modal-smoke @property-menu-smoke", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "create-modal" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();

      const project = await createConvergenceProject(page, "Create modal convergence", workspace);
      await page
        .getByRole("button", {
          name: "Open Create modal convergence",
          exact: true,
        })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const triageColumn = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(triageColumn).toBeVisible({ timeout: 15_000 });

      const createButton = triageColumn.locator(
        '[data-page-create-trigger="auto-collapsed-column"]',
      );
      await expect(createButton).toHaveAttribute("aria-disabled", "false", {
        timeout: 15_000,
      });
      await createButton.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Page title").fill("Modal-created Page");

      await page.evaluate(() => {
        const state = window as typeof window & {
          __createModalFrameCounts?: number[];
          __createModalFrameObserverActive?: boolean;
        };
        state.__createModalFrameCounts = [];
        state.__createModalFrameObserverActive = true;
        const sample = () => {
          if (!state.__createModalFrameObserverActive) return;
          const count = [
            ...document.querySelectorAll(
              '[data-board-column-root][data-board-column-id="triage"] [data-board-uuid-v7]',
            ),
          ].filter((card) => card.textContent?.includes("Modal-created Page")).length;
          if (count > 0 || state.__createModalFrameCounts?.length) {
            state.__createModalFrameCounts?.push(count);
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });

      await dialog.getByRole("button", { name: "Create page", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const createdCard = triageColumn.locator("[data-board-uuid-v7]").filter({
        hasText: "Modal-created Page",
      });
      await expect(createdCard).toHaveCount(1, { timeout: 15_000 });
      const createdPageId = requireString(
        await createdCard.getAttribute("data-board-uuid-v7"),
        "Modal-created Page id",
      );
      await expect
        .poll(async () => await readConvergenceBoardTotal(page, project), { timeout: 15_000 })
        .toBe(1);
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          let remaining = 8;
          const next = () => {
            remaining -= 1;
            if (remaining === 0) {
              resolve();
              return;
            }
            requestAnimationFrame(next);
          };
          requestAnimationFrame(next);
        });
        (
          window as typeof window & {
            __createModalFrameObserverActive?: boolean;
          }
        ).__createModalFrameObserverActive = false;
      });
      const frameCounts = await page.evaluate(
        () =>
          (
            window as typeof window & {
              __createModalFrameCounts?: number[];
            }
          ).__createModalFrameCounts ?? [],
      );
      expect(frameCounts.length).toBeGreaterThan(0);
      expect(new Set(frameCounts)).toEqual(new Set([1]));
      await expect(createdCard).toHaveCount(1);

      await createdCard
        .locator('[data-card-context-menu-trigger="true"]')
        .click({ button: "right" });
      const tagsItem = page.getByRole("menuitem", { name: /Tags/ });
      await expect(tagsItem).toBeVisible();
      await tagsItem.click();
      const tagsSearch = page.getByRole("combobox", { name: "Search Tags options" });
      await expect(tagsSearch).toBeVisible();
      await tagsSearch.fill("Context created");
      const createTag = page.getByRole("button", { name: "Create “Context created”" });
      await expect(createTag).toBeVisible();
      await createTag.click();
      await expect(
        page.getByLabel("Selected Tags").getByText("Context created", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 15_000 });
      await tagsSearch.press("Escape");
      await expect(tagsSearch).toHaveCount(0);

      await createdCard
        .locator('[data-card-context-menu-trigger="true"]')
        .click({ button: "right" });
      const assigneeItem = page.getByRole("menuitem", { name: /Assignee/ });
      await expect(assigneeItem).toBeVisible();
      await assigneeItem.click();
      const assigneeInput = page.getByRole("textbox", { name: "Assignee value" });
      await expect(assigneeInput).toBeVisible();
      const assigneeSubmenu = page
        .locator('[data-slot="context-menu-subcontent"]')
        .filter({ has: assigneeInput });
      await expect(assigneeSubmenu).toHaveCount(1);
      const assigneeSubmenuGeometry = await assigneeSubmenu.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
          boxShadow: style.boxShadow,
          clientWidth: element.clientWidth,
          overflowX: style.overflowX,
          scrollWidth: element.scrollWidth,
        };
      });
      expect(assigneeSubmenuGeometry.boxShadow).not.toBe("none");
      expect(assigneeSubmenuGeometry.overflowX).toBe("hidden");
      expect(assigneeSubmenuGeometry.scrollWidth).toBeLessThanOrEqual(
        assigneeSubmenuGeometry.clientWidth,
      );
      await assigneeInput.press("Escape");
      await expect(assigneeInput).toHaveCount(0);

      await createdCard
        .locator('[data-card-context-menu-trigger="true"]')
        .click({ button: "right" });
      const dueDateItem = page.getByRole("menuitem", { name: /Due date/ });
      await expect(dueDateItem).toBeVisible();
      await dueDateItem.click();
      const dueDateInput = page.getByRole("textbox", { name: "Due date date" });
      await expect(dueDateInput).toBeVisible();
      const dueDateSubmenu = page.getByRole("menu").filter({ has: dueDateInput });
      await expect(dueDateSubmenu.getByText("Empty", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit Due date" })).toHaveCount(0);
      await dueDateInput.press("Escape");
      await expect(dueDateInput).toHaveCount(0);

      await createdCard
        .locator('[data-card-context-menu-trigger="true"]')
        .click({ button: "right" });
      const statusItem = page.getByRole("menuitem", { name: /Status/ });
      await expect(statusItem).toBeVisible();
      await statusItem.click();
      const buildOption = page.getByRole("option", { name: "Build", exact: true });
      await expect(buildOption).toBeVisible();
      await buildOption.click();

      const buildColumn = page.locator('[data-board-column-root][data-board-column-id="build"]');
      await expect(
        buildColumn.locator("[data-board-uuid-v7]").filter({
          hasText: "Modal-created Page",
        }),
      ).toHaveCount(1, { timeout: 15_000 });
      await expect(createdCard).toHaveCount(0);
      await expect
        .poll(async () => await readConvergenceBoardTotal(page, project), { timeout: 15_000 })
        .toBe(1);

      await page
        .getByRole("tablist", { name: "Database views" })
        .getByRole("tab", { name: "List", exact: true })
        .click();
      const listGrid = page.getByRole("grid", { name: /List$/ });
      await expect(listGrid).toBeVisible({ timeout: 15_000 });
      const createdRow = listGrid.locator(
        `[data-list-row="true"][data-database-view-page-id="${createdPageId}"]`,
      );
      await expect(createdRow).toBeVisible();
      const priorityItem = page.getByRole("menuitem", { name: /Priority/ });
      const priorityOption = page.getByRole("option", { name: "P1 - High", exact: true });
      await expect(async () => {
        if (await priorityOption.isVisible()) return;
        if (!(await priorityItem.isVisible())) {
          await createdRow.click({ button: "right", timeout: 2_000 });
          await expect(priorityItem).toBeVisible({ timeout: 2_000 });
        }
        await priorityItem.click({ timeout: 2_000 });
        await expect(priorityOption).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
      await priorityOption.click({ timeout: 2_000 });

      await expect
        .poll(
          async () => {
            const snapshot = requireIpcValue<Record<string, unknown>>(
              await invokeIpc(page, "database:list-window:get", project.projectId, {
                databaseViewId: project.defaultDatabaseViewId,
                first: 50,
                presentationOverride: { layout: "list" },
              }),
              "Read Property-edited List window",
            );
            if (!Array.isArray(snapshot.rows)) return null;
            for (const occurrence of snapshot.rows) {
              if (!isRecord(occurrence) || !isRecord(occurrence.row)) continue;
              const row = occurrence.row;
              if (!isRecord(row.page) || row.page.pageId !== createdPageId) continue;
              if (!isRecord(row.values) || !isRecord(row.values.priority)) return null;
              if (!isRecord(row.values.tags) || !Array.isArray(row.values.tags.value)) return null;
              return {
                priority: row.values.priority.value,
                tagCount: row.values.tags.value.length,
              };
            }
            return null;
          },
          { timeout: 15_000 },
        )
        .toEqual({ priority: "p1-high", tagCount: 1 });
    } finally {
      await harness.close();
    }
  });

  test("converges a Block transfer into the live Board Page projection", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "board-convergence" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();

      const project = await createConvergenceProject(page, "Board convergence", workspace);
      const source = await createConvergencePage(page, project, "Source Page");
      const seeded = await seedConvergenceDocument(page, project, source);
      const database = await readConvergenceDatabase(page, project);

      await page
        .getByRole("button", {
          name: "Open Board convergence",
          exact: true,
        })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      await expect(
        page.locator('[data-board-column-root][data-board-column-id="triage"]'),
      ).toBeVisible({
        timeout: 10_000,
      });

      const receipt = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(page, "blocks:transfer", project.projectId, {
          operationId: createUuidV7(),
          projectId: project.projectId,
          storeEpoch: project.storeEpoch,
          mode: "move",
          rootBlockIds: [seeded.blockIds[1]],
          causalDependencies: [],
          source: { kind: "document", documentId: seeded.documentId },
          target: {
            kind: "data_source",
            dataSourceId: database.dataSourceId,
            placement: {
              kind: "direct",
              viewId: database.viewId,
              preferencesOverride: {
                rulesOverride: {},
                presentationOverride: {},
              },
              groupKey: "triage",
            },
          },
          promotionPolicy: "literal",
        }),
        "Transfer Block into Board",
      );
      if (!Array.isArray(receipt.resultRootBlockIds)) {
        throw new Error("Block transfer returned no result Page id");
      }
      const resultPageId = requireString(receipt.resultRootBlockIds[0], "Transferred Page id");
      const commitSeq = receipt.commitSeq;
      if (typeof commitSeq !== "number") {
        throw new Error("Block transfer returned no change-log sequence");
      }
      const evidence = receipt.transformationEvidence;
      expect(evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "promote",
            sourceBlockId: seeded.blockIds[1],
            resultPageId,
          }),
        ]),
      );

      const detail = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(page, "pages:detail:get", project.projectId, resultPageId, commitSeq),
        "Read transferred Page detail",
      );
      expect(detail.page).toMatchObject({
        title: "Dragged source",
        parent: {
          kind: "data_source",
          dataSourceId: database.dataSourceId,
        },
      });

      const card = page.locator(`[data-board-uuid-v7="${resultPageId}"]`);
      await expect(card).toBeVisible({ timeout: 5_000 });
      await expect(card).toContainText("Dragged source");
    } finally {
      await harness.close();
    }
  });

  test("keeps the Page editor mounted while its Document commits", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "page-edit" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Page edit stability", workspace);
      const fixturePage = await createConvergenceBoardPage(
        page,
        project,
        "Stable editor Page",
        "Existing body",
      );

      await page
        .getByRole("button", {
          name: "Open Page edit stability",
          exact: true,
        })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const card = page.locator(`[data-board-uuid-v7="${fixturePage.pageId}"]`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.click();
      await page.getByRole("tab", { name: "Stable editor Page" }).waitFor();

      const surface = page.locator('[data-page-stage-surface="true"]:visible');
      const editor = surface.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      await expect(editor).toBeVisible({ timeout: 15_000 });
      const detailBefore = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(page, "pages:detail:get", project.projectId, fixturePage.pageId),
        "Read Page detail before editing",
      );
      const commitSeqBefore = detailBefore.commitSeq;
      if (typeof commitSeqBefore !== "number") {
        throw new Error("Page detail has no commit sequence before editing");
      }

      await page.evaluate(() => {
        const target = globalThis as typeof globalThis & {
          __nodexPageEditStability?: {
            readonly observer: MutationObserver;
            editorRemovals: number;
            skeletonAdds: number;
            titleRemovals: number;
          };
        };
        const measurement = {
          editorRemovals: 0,
          skeletonAdds: 0,
          titleRemovals: 0,
          observer: null as unknown as MutationObserver,
        };
        const contains = (node: Node, selector: string): boolean =>
          node instanceof Element &&
          (node.matches(selector) || node.querySelector(selector) !== null);
        measurement.observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.removedNodes) {
              if (contains(node, '[aria-label="Page title"]')) {
                measurement.titleRemovals += 1;
              }
              if (contains(node, '.nfm-editor .ProseMirror[contenteditable="true"]')) {
                measurement.editorRemovals += 1;
              }
            }
            for (const node of record.addedNodes) {
              if (contains(node, '[role="status"][aria-busy="true"]')) {
                measurement.skeletonAdds += 1;
              }
            }
          }
        });
        measurement.observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        target.__nodexPageEditStability = measurement;
      });

      await editor.click();
      await page.keyboard.press("End");
      await page.keyboard.type("x");
      await expect
        .poll(
          async () => {
            const detail = requireIpcValue<Record<string, unknown>>(
              await invokeIpc(page, "pages:detail:get", project.projectId, fixturePage.pageId),
              "Read Page detail after editing",
            );
            return detail.commitSeq;
          },
          { timeout: 15_000 },
        )
        .toBeGreaterThan(commitSeqBefore);
      await page.waitForTimeout(100);

      const measurement = await page.evaluate(() => {
        const target = globalThis as typeof globalThis & {
          __nodexPageEditStability?: {
            readonly observer: MutationObserver;
            editorRemovals: number;
            skeletonAdds: number;
            titleRemovals: number;
          };
        };
        const current = target.__nodexPageEditStability;
        if (!current) throw new Error("Page edit stability measurement is missing");
        current.observer.disconnect();
        return {
          editorRemovals: current.editorRemovals,
          skeletonAdds: current.skeletonAdds,
          titleRemovals: current.titleRemovals,
        };
      });
      expect(measurement).toEqual({
        editorRemovals: 0,
        skeletonAdds: 0,
        titleRemovals: 0,
      });
      await expect(editor).toBeVisible();
    } finally {
      await harness.close();
    }
  });

  test("keeps semantic children and Code Tab/Shift-Tab behavior stable across restart @block-children-smoke", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "block-children" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Block children", workspace);
      const fixturePage = await createConvergenceBoardPage(
        page,
        project,
        "Block children contract",
        "Semantic container and atomic Block fixture",
      );
      await seedConvergenceDocument(
        page,
        project,
        fixturePage,
        [
          "Callout body",
          "\tCallout child",
          "▶ Toggle body",
          "\tToggle child",
          "```ts",
          "const value = 1",
          "```",
          "Code sibling",
          '<image source="data:image/gif;base64,R0lGODlhAQABAAAAACw="></image>',
          "Image sibling",
        ].join("\n"),
      );
      const openFixture = async (window: Page): Promise<Locator> => {
        await window.getByRole("button", { name: "Open Block children", exact: true }).click();
        await window.getByRole("tab", { name: "Project Home" }).waitFor();
        const board = window.locator('[data-board-column-root][data-board-column-id="triage"]');
        const card = board.locator(`[data-board-uuid-v7="${fixturePage.pageId}"]`);
        await expect(card).toBeVisible({ timeout: 15_000 });
        await card.click();
        await window.getByRole("tab", { name: "Block children contract" }).waitFor();
        const editor = window
          .getByRole("tabpanel", { name: /Block children contract$/ })
          .locator('.nfm-editor .ProseMirror[contenteditable="true"]');
        await expect(editor).toBeVisible({ timeout: 15_000 });
        return editor;
      };

      const editor = await openFixture(page);
      await editor.getByText("Callout body", { exact: true }).click();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+/`);
      await page.getByRole("dialog", { name: "Block actions" }).waitFor();
      await page.getByRole("option", { name: /^Turn into/ }).click();
      const turnIntoMenu = page.getByRole("dialog", { name: "Turn into" });
      await turnIntoMenu.waitFor();
      await turnIntoMenu.getByRole("menuitem", { name: "Callout" }).click();

      const callout = editor
        .locator('.bn-block[data-content-type="callout"]')
        .filter({ hasText: "Callout body" });
      const calloutChild = callout
        .locator(":scope > .bn-block-group > .bn-block-outer > .bn-block[data-id]")
        .first();
      const calloutId = requireString(await callout.getAttribute("data-id"), "Callout Block id");
      const calloutChildId = requireString(
        await calloutChild.getAttribute("data-id"),
        "Callout child Block id",
      );
      await expect(callout).toHaveAttribute("data-children-layout", "enclosed");
      await expect(calloutChild).toBeVisible();
      await expect(callout.locator(`.bn-block[data-id="${calloutChildId}"]`)).toHaveCount(1);

      const toggle = editor.locator('.bn-block[data-content-type="toggleListItem"]');
      const toggleWrapper = toggle.locator(".bn-toggle-wrapper");
      const initialDisclosure = await toggleWrapper.getAttribute("data-show-children");
      if (initialDisclosure === null) throw new Error("Toggle disclosure state is missing");
      await toggleWrapper.locator(".bn-toggle-button").click();
      await expect(toggleWrapper).toHaveAttribute(
        "data-show-children",
        initialDisclosure === "true" ? "false" : "true",
      );
      await toggleWrapper.locator(".bn-toggle-button").click();
      await expect(toggleWrapper).toHaveAttribute("data-show-children", initialDisclosure);

      const assertTabCannotNest = async (atomic: Locator, sibling: Locator): Promise<void> => {
        const siblingId = requireString(await sibling.getAttribute("data-id"), "Sibling Block id");
        await sibling.click();
        await page.keyboard.press("Home");
        await page.keyboard.press("Tab");
        await expect(sibling).toBeVisible();
        await expect(atomic.locator(`.bn-block[data-id="${siblingId}"]`)).toHaveCount(0);
      };
      const code = editor.locator('.bn-block[data-content-type="codeBlock"]');
      const codeSibling = editor
        .locator('.bn-block[data-content-type="paragraph"]')
        .filter({ hasText: "Code sibling" });
      const image = editor.locator('.bn-block[data-content-type="image"]');
      const imageSibling = editor
        .locator('.bn-block[data-content-type="paragraph"]')
        .filter({ hasText: "Image sibling" });
      await code.getByText("const value = 1", { exact: true }).click();
      await page.keyboard.press("Home");
      await page.keyboard.press("Tab");
      await expect.poll(() => code.locator("code").textContent()).toBe("\tconst value = 1");
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => code.locator("code").textContent()).toBe("const value = 1");
      await assertTabCannotNest(code, codeSibling);
      await assertTabCannotNest(image, imageSibling);
      const codeId = requireString(await code.getAttribute("data-id"), "Code Block id");
      const codeSiblingId = requireString(
        await codeSibling.getAttribute("data-id"),
        "Code sibling Block id",
      );
      const imageId = requireString(await image.getAttribute("data-id"), "Image Block id");
      const imageSiblingId = requireString(
        await imageSibling.getAttribute("data-id"),
        "Image sibling Block id",
      );

      const restartedPage = await harness.restart();
      const restartedEditor = await openFixture(restartedPage);
      const restartedCallout = restartedEditor.locator(`.bn-block[data-id="${calloutId}"]`);
      await expect(restartedCallout).toHaveAttribute("data-children-layout", "enclosed");
      await expect(
        restartedCallout.locator(`.bn-block[data-id="${calloutChildId}"]`),
      ).toBeVisible();
      await expect(
        restartedEditor
          .locator(`.bn-block[data-id="${codeId}"]`)
          .locator(`.bn-block[data-id="${codeSiblingId}"]`),
      ).toHaveCount(0);
      await expect(
        restartedEditor
          .locator(`.bn-block[data-id="${imageId}"]`)
          .locator(`.bn-block[data-id="${imageSiblingId}"]`),
      ).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });

  test("moves selected Blocks to a DB status through the picker @move-picker-smoke", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "move-picker" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();

      const project = await createConvergenceProject(page, "Move picker smoke", workspace);
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Picker source Page",
        "Page containing the picker move fixture",
      );
      await seedConvergenceDocument(
        page,
        project,
        source,
        ["Before picker sibling", "Picker promoted title", "After picker sibling"].join("\n"),
      );

      await page
        .getByRole("button", {
          name: "Open Move picker smoke",
          exact: true,
        })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const triageColumn = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(triageColumn).toBeVisible({ timeout: 15_000 });
      await expect(triageColumn.locator("[data-board-uuid-v7]")).toHaveCount(1);

      await openBoardPageFromCard({
        card: triageColumn.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        page,
        tabName: "Picker source Page",
      });

      const sourcePanel = page.getByRole("tabpanel", {
        name: /Picker source Page$/,
      });
      const sourceSurface = sourcePanel.locator('.nfm-editor .ProseMirror[contenteditable="true"]');
      const sourceBlock = sourceSurface
        .locator(".bn-block[data-id]")
        .filter({
          hasText: "Picker promoted title",
        })
        .first();
      await expect(sourceBlock).toBeVisible({ timeout: 15_000 });
      await sourceBlock.click();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+/`);

      await page.getByRole("dialog", { name: "Block actions" }).waitFor();
      await page.getByRole("option", { name: /^Move to/ }).click();
      await page.getByRole("combobox", { name: "Move blocks to" }).waitFor();
      await page
        .locator(
          `[data-nfm-move-to-row-kind="db-column"]` +
            `[data-nfm-move-to-project-id="${project.projectId}"]`,
        )
        .filter({ hasText: "Triage" })
        .click();

      await expect(triageColumn.locator("[data-board-uuid-v7]")).toHaveCount(2, {
        timeout: 15_000,
      });
      await expect(
        triageColumn.locator("[data-board-uuid-v7]").filter({
          hasText: "Picker promoted title",
        }),
      ).toHaveCount(1);
      await expect(sourceBlock).toHaveCount(0, { timeout: 15_000 });
      await expect(
        sourceSurface.locator(".bn-block[data-id]").filter({
          hasText: "Before picker sibling",
        }),
      ).toHaveCount(1);
      await expect(
        sourceSurface.locator(".bn-block[data-id]").filter({
          hasText: "After picker sibling",
        }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("alert").filter({
          hasText: "Something went wrong",
        }),
      ).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });

  test("reorders an ordinary editor subtree across a Subpage with native DnD @editor-dnd-smoke", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "editor-subtree-dnd" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Editor subtree DnD", workspace);
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Editor subtree source",
        "Page containing the same-Document DnD fixture",
      );
      const seeded = await seedConvergenceDocument(
        page,
        project,
        source,
        ["1111", "\t222", "middle", "3333"].join("\n"),
      );
      const sourceRootId = requireString(seeded.blockIds[0], "Parent Block id");
      const childId = requireString(seeded.blockIds[1], "Child Block id");
      const tailId = requireString(seeded.blockIds.at(-1), "Tail Block id");
      const subpage = await createConvergenceSubpage(
        page,
        project,
        source,
        "Typed owner boundary",
        tailId,
      );

      await page.getByRole("button", { name: "Open Editor subtree DnD", exact: true }).click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        page,
        tabName: "Editor subtree source",
      });

      const sourcePanel = page.getByRole("tabpanel", { name: /Editor subtree source$/ });
      const sourceEditor = sourcePanel.locator(".nfm-editor");
      const sourceSurface = sourceEditor.locator('.ProseMirror[contenteditable="true"]');
      const sourceBlock = sourceSurface.locator(`.bn-block[data-id="${sourceRootId}"]`);
      const sourceOuter = sourceSurface.locator(`.bn-block-outer[data-id="${sourceRootId}"]`);
      const child = sourceOuter.locator(`.bn-block[data-id="${childId}"]`);
      const tail = sourceSurface.locator(`.bn-block[data-id="${tailId}"]`);
      await expect(sourceBlock).toBeVisible({ timeout: 15_000 });
      await expect(child).toBeVisible();
      await expect(sourceSurface.locator(`.bn-block[data-id="${subpage.pageId}"]`)).toBeVisible();
      await expect(tail).toBeVisible();

      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock,
        sourceEditor,
        target: tail,
        targetYRatio: 0.85,
        expectedFeedback: sourceEditor.locator("[data-block-transfer-drop-indicator]"),
      });

      await expect
        .poll(
          async () => {
            const [sourceBox, tailBox] = await Promise.all([
              sourceBlock.boundingBox(),
              tail.boundingBox(),
            ]);
            return Boolean(sourceBox && tailBox && sourceBox.y > tailBox.y);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(child).toBeVisible();
      await expect(
        page.getByText("Nodex blocked an incomplete structural change.", { exact: false }),
      ).toHaveCount(0);

      await sourceBlock.click();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect
        .poll(
          async () => {
            const [sourceBox, tailBox] = await Promise.all([
              sourceBlock.boundingBox(),
              tail.boundingBox(),
            ]);
            return Boolean(sourceBox && tailBox && sourceBox.y < tailBox.y);
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      await expect(child).toBeVisible();
    } finally {
      await harness.close();
    }
  });

  test("moves an editor subtree into a collapsed toggle with native DnD @editor-dnd-smoke", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "editor-toggle-dnd" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Editor toggle DnD", workspace);
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Editor toggle source",
        "Page containing the collapsed-toggle DnD fixture",
      );
      const seeded = await seedConvergenceDocument(
        page,
        project,
        source,
        [
          "Dragged parent",
          "\tDragged child",
          "▶ Target toggle",
          "\tExisting toggle child",
          "Tail",
        ].join("\n"),
      );
      const sourceRootId = requireString(seeded.blockIds[0], "Dragged parent Block id");
      const sourceChildId = requireString(seeded.blockIds[1], "Dragged child Block id");
      const toggleId = requireString(seeded.blockIds[2], "Target toggle Block id");
      const existingChildId = requireString(seeded.blockIds[3], "Existing toggle child Block id");

      await page.getByRole("button", { name: "Open Editor toggle DnD", exact: true }).click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const board = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await openBoardPageFromCard({
        card: board.locator(`[data-board-uuid-v7="${source.pageId}"]`),
        page,
        tabName: "Editor toggle source",
      });

      const sourcePanel = page.getByRole("tabpanel", { name: /Editor toggle source$/ });
      const sourceEditor = sourcePanel.locator(".nfm-editor");
      const sourceSurface = sourceEditor.locator('.ProseMirror[contenteditable="true"]');
      const sourceBlock = sourceSurface.locator(`.bn-block[data-id="${sourceRootId}"]`);
      const sourceOuter = sourceSurface.locator(`.bn-block-outer[data-id="${sourceRootId}"]`);
      const sourceChild = sourceOuter.locator(`.bn-block[data-id="${sourceChildId}"]`);
      const toggleBlock = sourceSurface.locator(`.bn-block[data-id="${toggleId}"]`);
      const toggleOuter = sourceSurface.locator(`.bn-block-outer[data-id="${toggleId}"]`);
      const toggleContent = toggleBlock.locator(":scope > .bn-block-content");
      const toggleWrapper = toggleContent.locator(".bn-toggle-wrapper");
      await expect(sourceBlock).toBeVisible({ timeout: 15_000 });
      await expect(sourceChild).toBeVisible();
      await expect(toggleBlock).toBeVisible();
      await expect(toggleWrapper).toHaveAttribute("data-show-children", "false");

      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock,
        sourceEditor,
        target: toggleContent,
        targetYRatio: 0.5,
        expectedFeedback: sourceEditor.locator("[data-toggle-drop-overlay]"),
        onFeedback: async () => {
          await expect(sourceEditor.locator("[data-block-transfer-drop-indicator]")).toHaveCount(0);
          await expect(toggleWrapper).toHaveAttribute("data-show-children", "false");
        },
      });

      await expect(sourceBlock).toBeHidden({ timeout: 15_000 });
      await expect(toggleWrapper).toHaveAttribute("data-show-children", "false");
      await expect
        .poll(async () =>
          sourceSurface.evaluate(() => {
            const anchor = document.getSelection()?.anchorNode;
            const element = anchor instanceof Element ? anchor : anchor?.parentElement;
            return element?.closest<HTMLElement>(".bn-block[data-id]")?.dataset.id ?? null;
          }),
        )
        .toBe(toggleId);

      await toggleWrapper.locator(".bn-toggle-button").click();
      await expect(toggleOuter.locator(`.bn-block[data-id="${existingChildId}"]`)).toBeVisible();
      await expect(toggleOuter.locator(`.bn-block[data-id="${sourceRootId}"]`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(toggleOuter.locator(`.bn-block[data-id="${sourceChildId}"]`)).toBeVisible();
      await expect
        .poll(async () => {
          const [existingBox, sourceBox] = await Promise.all([
            toggleOuter.locator(`.bn-block[data-id="${existingChildId}"]`).boundingBox(),
            toggleOuter.locator(`.bn-block[data-id="${sourceRootId}"]`).boundingBox(),
          ]);
          return Boolean(existingBox && sourceBox && existingBox.y < sourceBox.y);
        })
        .toBe(true);
      await expect(
        page.getByText("Nodex blocked an incomplete structural change.", { exact: false }),
      ).toHaveCount(0);

      await toggleBlock.click();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Z`);
      await expect(sourceBlock).toBeVisible({ timeout: 15_000 });
      await expect(toggleOuter.locator(`.bn-block[data-id="${sourceRootId}"]`)).toHaveCount(0);
      await expect(sourceChild).toBeVisible();
    } finally {
      await harness.close();
    }
  });

  // This is the native source-gesture smoke. High-pressure tests below remain on
  // the direct typed transfer boundary because they test transaction convergence,
  // not the handle-to-dragover pipeline exercised here.
  test("moves a Block into Board and List views with native DnD @dnd-smoke", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "native-dnd" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();

      const project = await createConvergenceProject(page, "Native DnD smoke", workspace);
      const database = await readConvergenceDatabase(page, project);
      const firstBoardFixture = await createConvergenceBoardPage(
        page,
        project,
        "Board fixture one",
        "First existing Board Page",
      );
      await createConvergenceBoardPage(
        page,
        project,
        "Board fixture two",
        "Second existing Board Page",
      );
      const source = await createConvergenceBoardPage(
        page,
        project,
        "DnD source Page",
        "Page containing the native DnD fixture",
      );
      await seedConvergenceDocument(
        page,
        project,
        source,
        [
          "Before smoke sibling",
          "1XL(ui, unclear) DnD smoke title",
          "\tDnD smoke first child",
          "\tDnD smoke middle child",
          "\tDnD smoke last child",
        ].join("\n"),
      );

      await page
        .getByRole("button", {
          name: "Open Native DnD smoke",
          exact: true,
        })
        .click();
      await page.getByRole("tab", { name: "Project Home" }).waitFor();
      const triageColumn = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(triageColumn).toBeVisible({ timeout: 15_000 });
      await expect(triageColumn.locator("[data-board-uuid-v7]")).toHaveCount(3, {
        timeout: 15_000,
      });

      const sourceCard = triageColumn.locator(`[data-board-uuid-v7="${source.pageId}"]`);
      await expect(sourceCard).toBeVisible();
      await openBoardPageFromCard({ card: sourceCard, page, tabName: "DnD source Page" });
      await expect(triageColumn).toBeVisible({ timeout: 15_000 });

      const sourcePanel = page.getByRole("tabpanel", {
        name: /DnD source Page$/,
      });
      await expect(sourcePanel).toBeVisible();
      const sourceEditor = sourcePanel.locator(".nfm-editor");
      const sourceSurface = sourceEditor.locator('.ProseMirror[contenteditable="true"]');
      await expect(sourceSurface).toBeVisible({ timeout: 15_000 });
      const sourceBlock = sourceSurface
        .locator(".bn-block[data-id]")
        .filter({
          hasText: "1XL(ui, unclear) DnD smoke title",
        })
        .first();
      await expect(sourceBlock).toBeVisible();

      const triageHeader = page
        .locator('[data-database-board-column-header="true"]')
        .filter({ hasText: "Triage" });
      await triageHeader.hover();
      await triageHeader
        .getByRole("button", {
          name: "More options for Triage",
        })
        .click();
      await page.getByRole("button", { name: "Collapse", exact: true }).click();
      await expect(triageColumn).toHaveAttribute("data-board-column-collapsed", "true");
      const collapsedTriageRail = triageColumn.getByRole("button", {
        name: "Expand Triage",
      });
      await expect(collapsedTriageRail).toBeVisible();
      const collapsedHeader = triageHeader;
      const collapsedDropFeedback = collapsedHeader.locator(
        '[data-board-collapsed-drop-indicator="true"]',
      );

      await expectClosingSideMenuToBeInert({ page, sourceBlock, sourceEditor });
      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock,
        sourceEditor,
        target: collapsedTriageRail,
        expectedFeedback: collapsedDropFeedback,
        onFeedback: async () => {
          await expect(
            collapsedDropFeedback.locator('[data-board-property-change-indicator="true"]'),
          ).toBeVisible();
          const [headerBox, moreBox, lineBox] = await Promise.all([
            collapsedHeader.boundingBox(),
            collapsedHeader
              .getByRole("button", {
                name: "More options for Triage",
              })
              .boundingBox(),
            collapsedDropFeedback.boundingBox(),
          ]);
          if (!headerBox || !moreBox || !lineBox) {
            throw new Error("Collapsed Board drop feedback geometry is unavailable");
          }
          expect(headerBox.height).toBeGreaterThan(40);
          expect(lineBox.y).toBeGreaterThanOrEqual(moreBox.y + moreBox.height);
          expect(
            Math.abs(lineBox.y + lineBox.height - (headerBox.y + headerBox.height)),
          ).toBeLessThanOrEqual(1);
        },
        exerciseAncestorScrollLifecycle: true,
      });

      await collapsedTriageRail.click();
      await expect(triageColumn).toHaveAttribute("data-board-column-collapsed", "false");
      await expect(triageColumn.locator("[data-board-uuid-v7]")).toHaveCount(4, {
        timeout: 15_000,
      });
      await expect
        .poll(async () => await readConvergenceBoardTotal(page, project), { timeout: 15_000 })
        .toBe(4);
      const promotedCards = triageColumn
        .locator(`[data-board-uuid-v7]:not([data-board-uuid-v7="${source.pageId}"])`)
        .filter({ hasText: "DnD smoke title" });
      await expect(promotedCards).toHaveCount(1, { timeout: 15_000 });
      await expect(promotedCards).toBeVisible();
      await expect(sourceBlock).toHaveCount(0, { timeout: 15_000 });
      await expect(
        sourceSurface.locator(".bn-block[data-id]").filter({
          hasText: "Before smoke sibling",
        }),
      ).toHaveCount(1);
      await expect(sourcePanel.getByRole("button", { name: "Reload" })).toHaveCount(0);
      await expect(sourceSurface).toHaveAttribute("contenteditable", "true");

      const promotedPageId = requireString(
        await promotedCards.getAttribute("data-board-uuid-v7"),
        "Native DnD promoted Page id",
      );
      const detail = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(page, "pages:detail:get", project.projectId, promotedPageId),
        "Read native DnD promoted Page detail",
      );
      expect(detail.page).toMatchObject({
        title: "DnD smoke title",
        parent: {
          kind: "data_source",
          dataSourceId: database.dataSourceId,
        },
        plainText: expect.stringContaining("DnD smoke first child"),
      });
      expect(detail.page).toMatchObject({
        plainText: expect.stringContaining("DnD smoke last child"),
      });
      expect(detail.dataSourceContext).toMatchObject({
        kind: "member",
        values: {
          priority: { value: "p1-high" },
          estimate: { value: "xl" },
          status: { value: "triage" },
        },
      });
      const dataSourceContext = detail.dataSourceContext;
      if (!isRecord(dataSourceContext) || !isRecord(dataSourceContext.values)) {
        throw new Error("Native DnD Data Source context is unavailable");
      }
      const tagsValue = dataSourceContext.values.tags;
      if (!isRecord(tagsValue)) {
        throw new Error("Native DnD Tags value is unavailable");
      }
      const tags = tagsValue.value;
      expect(tags).toEqual(expect.any(Array));
      expect(tags).toHaveLength(2);
      const promotionToast = page
        .locator('[data-slot="toast-item"]')
        .filter({ hasText: "Task shorthand applied" });
      await expect(promotionToast.locator('[role="alert"]')).toBeVisible();
      await promotionToast.getByRole("button", { name: "Undo" }).click();

      await expect(promotedCards).toHaveCount(0, { timeout: 15_000 });
      await expect
        .poll(async () => await readConvergenceBoardTotal(page, project), { timeout: 15_000 })
        .toBe(3);
      await expect
        .poll(
          async () => {
            const restored = requireIpcValue<Record<string, unknown>>(
              await invokeIpc(page, "pages:detail:get", project.projectId, source.pageId),
              "Read restored source Page detail",
            );
            return isRecord(restored.page) ? restored.page.plainText : null;
          },
          { timeout: 15_000 },
        )
        .toEqual(expect.stringContaining("1XL(ui, unclear) DnD smoke title"));
      await page.getByRole("tab", { name: "DnD source Page" }).click();
      await expect(sourceSurface).toBeVisible({ timeout: 15_000 });
      await expect(sourceBlock).toHaveCount(1, { timeout: 15_000 });

      await page
        .getByRole("tablist", { name: "Database views" })
        .getByRole("tab", { name: "List", exact: true })
        .click();
      const list = page.getByRole("grid", { name: /List$/ });
      await expect(list).toBeVisible({ timeout: 15_000 });
      const listTarget = list.locator(
        `[data-list-row="true"][data-database-view-page-id="${firstBoardFixture.pageId}"]`,
      );
      await expect(listTarget).toBeVisible({ timeout: 15_000 });

      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock,
        sourceEditor,
        target: listTarget,
        targetYRatio: 0.25,
        expectedFeedback: listTarget.locator('[data-list-drop-indicator="true"]'),
      });

      const promotedListRows = list
        .locator('[data-list-row="true"][data-database-view-page-id]')
        .filter({ hasText: "DnD smoke title" });
      await expect(promotedListRows).toHaveCount(1, { timeout: 15_000 });
      await expect(sourceBlock).toHaveCount(0, { timeout: 15_000 });
      await expect(sourcePanel.getByRole("button", { name: "Reload" })).toHaveCount(0);
      await expect(sourceSurface).toHaveAttribute("contenteditable", "true");
      const promotedListPageId = requireString(
        await promotedListRows.getAttribute("data-database-view-page-id"),
        "Native List DnD promoted Page id",
      );
      const promotedListDetail = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(page, "pages:detail:get", project.projectId, promotedListPageId),
        "Read native List DnD promoted Page detail",
      );
      expect(promotedListDetail.page).toMatchObject({
        title: "DnD smoke title",
        parent: {
          kind: "data_source",
          dataSourceId: database.dataSourceId,
        },
      });
      expect(promotedListDetail.dataSourceContext).toMatchObject({
        kind: "member",
        values: {
          priority: { value: "p1-high" },
          estimate: { value: "xl" },
          status: { value: "triage" },
        },
      });
      const listPromotionToast = page
        .locator('[data-slot="toast-item"]')
        .filter({ hasText: "Task shorthand applied" })
        .last();
      await expect(listPromotionToast.locator('[role="alert"]')).toBeVisible();
      await listPromotionToast.getByRole("button", { name: "Undo" }).click();
      await expect(promotedListRows).toHaveCount(0, { timeout: 15_000 });
      await expect(sourceBlock).toHaveCount(1, { timeout: 15_000 });
    } finally {
      await harness.close();
    }
  });

  test("promotes an image-bearing Block into Board without cloning its File @page-file-placement", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "page-file-placement" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Page File placement", workspace);
      await createConvergenceBoardPage(page, project, "Image fixture", "Existing Board Page");
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Image source Page",
        "Page containing an image-bearing Block",
      );
      await seedConvergenceDocument(
        page,
        project,
        source,
        ["Before image sibling", "Image placement promotion", "\tImage placement child"].join("\n"),
      );

      await page.getByRole("button", { name: "Open Page File placement", exact: true }).click();
      const triageColumn = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(triageColumn).toBeVisible({ timeout: 15_000 });
      const sourceCard = triageColumn.locator(`[data-board-uuid-v7="${source.pageId}"]`);
      await openBoardPageFromCard({ card: sourceCard, page, tabName: "Image source Page" });

      const sourcePanel = page.getByRole("tabpanel", { name: /Image source Page$/ });
      const sourceEditor = sourcePanel.locator(".nfm-editor");
      const sourceSurface = sourceEditor.locator('.ProseMirror[contenteditable="true"]');
      const sourceBlock = sourceSurface
        .locator(".bn-block[data-id]")
        .filter({ hasText: "Image placement promotion" })
        .first();
      const childContent = sourceSurface
        .locator(".bn-block-content")
        .filter({ hasText: /^Image placement child$/u });
      await expect(childContent).toHaveCount(1);
      await childContent.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");

      const savedClipboard = await harness.application.evaluate(({ clipboard }) => ({
        html: clipboard.readHTML(),
        image: clipboard.readImage().toDataURL(),
        text: clipboard.readText(),
      }));
      let sourceFileUrl: string | null = null;
      try {
        await harness.application.evaluate(({ clipboard, nativeImage }) => {
          clipboard.writeImage(
            nativeImage.createFromDataURL(
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            ),
          );
        });
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+V`);
        const sourceImage = sourceBlock.locator(
          '[data-content-type="image"][data-url^="nodex://files/"]',
        );
        await expect(sourceImage.locator("img")).toHaveAttribute(
          "src",
          /^(?:blob:|data:image\/png;base64,)/u,
          { timeout: 15_000 },
        );
        sourceFileUrl = requireString(
          await sourceImage.getAttribute("data-url"),
          "Source image File URL",
        );
      } finally {
        await harness.application.evaluate(({ clipboard, nativeImage }, saved) => {
          clipboard.write({
            html: saved.html,
            image: nativeImage.createFromDataURL(saved.image),
            text: saved.text,
          });
        }, savedClipboard);
      }
      const placedFileUrl = requireString(sourceFileUrl, "Source image File URL");
      await sourcePanel.getByRole("button", { name: /\d+ more propert(?:y|ies)/u }).click();
      await expect(
        sourcePanel.getByRole("button", { name: "Open 1 File shown in Page" }),
      ).toBeVisible();

      const triageHeader = page
        .locator('[data-database-board-column-header="true"]')
        .filter({ hasText: "Triage" });
      await triageHeader.hover();
      await triageHeader.getByRole("button", { name: "More options for Triage" }).click();
      await page.getByRole("button", { name: "Collapse", exact: true }).click();
      const collapsedTriageRail = triageColumn.getByRole("button", { name: "Expand Triage" });
      await dragBlockFromEditorWithMouse({
        page,
        sourceBlock,
        sourceEditor,
        target: collapsedTriageRail,
        expectedFeedback: triageHeader.locator('[data-board-collapsed-drop-indicator="true"]'),
      });
      await expect
        .poll(async () => await readConvergenceBoardTotal(page, project), { timeout: 15_000 })
        .toBe(3);
      await collapsedTriageRail.focus();
      await page.keyboard.press("Enter");

      const promotedCard = triageColumn
        .locator(`[data-board-uuid-v7]:not([data-board-uuid-v7="${source.pageId}"])`)
        .filter({ hasText: "Image placement promotion" });
      await expect(promotedCard).toHaveCount(1, { timeout: 15_000 });
      await expect(sourceBlock).toHaveCount(0, { timeout: 15_000 });
      await openBoardPageFromCard({
        card: promotedCard,
        page,
        tabName: "Image placement promotion",
      });
      const promotedPanel = page.getByRole("tabpanel", { name: /Image placement promotion$/ });
      const promotedImage = promotedPanel.locator(
        '[data-content-type="image"][data-url^="nodex://files/"]',
      );
      await expect(promotedImage).toHaveAttribute("data-url", placedFileUrl);
      await expect(promotedImage.locator("img")).toHaveAttribute(
        "src",
        /^(?:blob:|data:image\/png;base64,)/u,
        { timeout: 15_000 },
      );
      await promotedPanel.getByRole("button", { name: /\d+ more propert(?:y|ies)/u }).click();
      await expect(
        promotedPanel.getByRole("button", { name: "Open 1 File shown in Page" }),
      ).toBeVisible();
      await expect(page.getByText("Image unavailable", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Page Document references a File", { exact: false })).toHaveCount(
        0,
      );

      await triageHeader.hover();
      await triageHeader.getByRole("button", { name: "More options for Triage" }).focus();
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+z`);
      await expect(promotedCard).toHaveCount(0, { timeout: 15_000 });
      await page.getByRole("tab", { name: "Image source Page" }).click();
      await expect(sourceBlock).toHaveCount(1, { timeout: 15_000 });
      const restoredImage = sourceBlock.locator(
        '[data-content-type="image"][data-url^="nodex://files/"]',
      );
      await expect(restoredImage).toHaveAttribute("data-url", placedFileUrl);
      await expect(restoredImage.locator("img")).toHaveAttribute(
        "src",
        /^(?:blob:|data:image\/png;base64,)/u,
        { timeout: 15_000 },
      );
      const restoredSourceFiles = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(
          page,
          "library-module:read",
          { kind: "project", projectId: project.projectId },
          {
            read: {
              mode: "page_files",
              pageId: source.pageId,
              limit: 100,
              includeDeleted: false,
            },
          },
        ),
        "Read restored source Page Files",
      );
      expect(restoredSourceFiles.value).toMatchObject({
        kind: "page_files",
        value: {
          liveTotal: 1,
          files: [
            {
              ownerPageId: source.pageId,
              bodyUsage: { kind: "placed", placementCount: 1 },
            },
          ],
        },
      });
      const moreSourceProperties = sourcePanel.getByRole("button", {
        name: /\d+ more propert(?:y|ies)/u,
      });
      if (await moreSourceProperties.isVisible()) await moreSourceProperties.click();
      await expect(
        sourcePanel.getByRole("button", { name: "Open 1 File shown in Page" }),
      ).toBeVisible();
      await expect(page.getByText("Image unavailable", { exact: true })).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });

  test("cuts and pastes a clicked image Block across Windows at sibling depth with stable File identity @page-file-placement", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "page-file-exclusive-move" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();
      const project = await createConvergenceProject(page, "Page File move", workspace);
      const target = await createConvergenceBoardPage(
        page,
        project,
        "Collision target Page",
        "Page with the target namespace collision",
      );
      const source = await createConvergenceBoardPage(
        page,
        project,
        "Exclusive source Page",
        "Page with the File placement to move",
      );
      await seedConvergenceDocument(
        page,
        project,
        target,
        ["Target image owner", "\tTarget image child"].join("\n"),
      );
      await seedConvergenceDocument(
        page,
        project,
        source,
        ["Source image owner", "\tSource image child", "Source sibling"].join("\n"),
      );

      await page.getByRole("button", { name: "Open Page File move", exact: true }).click();
      const triageColumn = page.locator('[data-board-column-root][data-board-column-id="triage"]');
      await expect(triageColumn).toBeVisible({ timeout: 15_000 });
      const targetCard = triageColumn.locator(`[data-board-uuid-v7="${target.pageId}"]`);
      const sourceCard = triageColumn.locator(`[data-board-uuid-v7="${source.pageId}"]`);

      const savedClipboard = await harness.application.evaluate(({ clipboard }) => ({
        html: clipboard.readHTML(),
        image: clipboard.readImage().toDataURL(),
        text: clipboard.readText(),
      }));
      try {
        await harness.application.evaluate(({ clipboard, nativeImage }) => {
          clipboard.writeImage(
            nativeImage.createFromDataURL(
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            ),
          );
        });

        await openBoardPageFromCard({
          card: targetCard,
          page,
          tabName: "Collision target Page",
        });
        const targetPanel = page.getByRole("tabpanel", { name: /Collision target Page$/ });
        const targetSurface = targetPanel.locator(
          '.nfm-editor .ProseMirror[contenteditable="true"]',
        );
        const targetParent = targetSurface
          .locator(".bn-block[data-id]")
          .filter({ hasText: "Target image owner" })
          .first();
        await targetSurface
          .locator(".bn-block-content")
          .filter({ hasText: /^Target image child$/u })
          .click();
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+v`);
        const targetImage = targetParent.locator(
          '[data-content-type="image"][data-url^="nodex://files/"]',
        );
        await expect(targetImage.locator("img")).toHaveAttribute(
          "src",
          /^(?:blob:|data:image\/png;base64,)/u,
          { timeout: 15_000 },
        );

        await openBoardPageFromCard({
          card: sourceCard,
          page,
          tabName: "Exclusive source Page",
        });
        const sourcePanel = page.getByRole("tabpanel", { name: /Exclusive source Page$/ });
        const sourceEditor = sourcePanel.locator(".nfm-editor");
        const sourceSurface = sourceEditor.locator('.ProseMirror[contenteditable="true"]');
        const sourceParent = sourceSurface
          .locator(".bn-block[data-id]")
          .filter({ hasText: "Source image owner" })
          .first();
        const sourceSibling = sourceSurface
          .locator(".bn-block-content")
          .filter({ hasText: /^Source sibling$/u });
        await sourceSibling.click();
        await page.keyboard.press("End");
        await page.keyboard.press("Enter");
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+v`);
        const sourceImage = sourceSurface.locator(
          '[data-content-type="image"][data-url^="nodex://files/"]',
        );
        await expect(sourceImage.locator("img")).toHaveAttribute(
          "src",
          /^(?:blob:|data:image\/png;base64,)/u,
          { timeout: 15_000 },
        );
        const sourceFileUrl = requireString(
          await sourceImage.getAttribute("data-url"),
          "Exclusive source File URL",
        );
        const sourceBefore = await readConvergencePageFiles(page, project.projectId, source.pageId);
        const targetBefore = await readConvergencePageFiles(page, project.projectId, target.pageId);
        expect(sourceBefore.liveTotal).toBe(1);
        expect(targetBefore.liveTotal).toBe(1);
        const sourceFileId = requireString(sourceBefore.files[0]?.fileId, "Source File id");

        const sourceImageBlockId = requireString(
          await sourceImage.evaluate((image) =>
            image.closest<HTMLElement>(".bn-block[data-id]")?.getAttribute("data-id"),
          ),
          "Cut source image Block id",
        );
        const targetWindowOpened = harness.application.waitForEvent("window");
        expect(await invokeIpc(page, "window:new", {})).toBe(true);
        const targetPage = await targetWindowOpened;
        await targetPage.evaluate(() => window.api?.awaitInitialization?.());
        await targetPage.getByRole("button", { name: "Open Page File move", exact: true }).click();
        await targetPage.getByRole("tab", { name: "Project Home" }).waitFor();
        const targetWindowColumn = targetPage.locator(
          '[data-board-column-root][data-board-column-id="triage"]',
        );
        await expect(targetWindowColumn).toBeVisible({ timeout: 15_000 });
        await openBoardPageFromCard({
          card: targetWindowColumn.locator(`[data-board-uuid-v7="${target.pageId}"]`),
          page: targetPage,
          tabName: "Collision target Page",
        });
        const targetWindowPanel = targetPage.getByRole("tabpanel", {
          name: /Collision target Page$/,
        });
        const targetWindowSurface = targetWindowPanel.locator(
          '.nfm-editor .ProseMirror[contenteditable="true"]',
        );
        const targetWindowParent = targetWindowSurface
          .locator(".bn-block[data-id]")
          .filter({ hasText: "Target image owner" })
          .first();
        await expect(targetWindowParent).toBeVisible({ timeout: 15_000 });
        const targetWindowExistingImage = targetWindowParent.locator(
          '[data-content-type="image"] img',
        );
        await expect(targetWindowExistingImage).toHaveAttribute("src", /^blob:|^data:image\//u, {
          timeout: 15_000,
        });
        const existingImageSrc = requireString(
          await targetWindowExistingImage.getAttribute("src"),
          "Existing target image source",
        );
        await targetWindowExistingImage.evaluate((image) => {
          image.setAttribute("data-file-cache-marker", "stable");
        });

        await sourceImage.click();
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+x`);
        await targetWindowParent.locator(":scope > .bn-block-content").click();
        await targetPage.keyboard.press("End");
        await targetPage.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+v`);

        await expect(sourceImage).toHaveCount(0, { timeout: 15_000 });
        await expect(sourceParent).toHaveCount(1);
        await expect
          .poll(
            async () => ({
              source: (await readConvergencePageFiles(page, project.projectId, source.pageId))
                .liveTotal,
              target: (await readConvergencePageFiles(page, project.projectId, target.pageId))
                .liveTotal,
            }),
            { timeout: 15_000 },
          )
          .toEqual({ source: 0, target: 2 });
        const targetAfter = await readConvergencePageFiles(page, project.projectId, target.pageId);
        expect(targetAfter.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              fileId: sourceFileId,
              ownerPageId: target.pageId,
              logicalPath: "image (2).png",
              bodyUsage: { kind: "placed", placementCount: 1 },
            }),
          ]),
        );

        const movedImages = targetWindowPanel.locator(
          `[data-content-type="image"][data-url="${sourceFileUrl}"]`,
        );
        await expect(movedImages).toHaveCount(1);
        await expect(movedImages.locator("img")).toHaveAttribute(
          "src",
          /^(?:blob:|data:image\/png;base64,)/u,
          { timeout: 15_000 },
        );
        await expect(targetWindowExistingImage).toHaveAttribute("data-file-cache-marker", "stable");
        await expect(targetWindowExistingImage).toHaveAttribute("src", existingImageSrc);
        const movedBlockId = requireString(
          await movedImages.evaluate((image) =>
            image.closest<HTMLElement>(".bn-block[data-id]")?.getAttribute("data-id"),
          ),
          "Pasted source Block id",
        );
        expect(movedBlockId).toBe(sourceImageBlockId);
        const targetParentBlockId = requireString(
          await targetWindowParent.getAttribute("data-id"),
          "Target sibling Block id",
        );
        expect(
          await movedImages.evaluate((image, anchorBlockId) => {
            const movedOuter = image.closest(".bn-block-outer");
            const anchor = [...document.querySelectorAll<HTMLElement>(".bn-block[data-id]")].find(
              (block) => block.dataset.id === anchorBlockId,
            );
            return movedOuter?.parentElement === anchor?.closest(".bn-block-outer")?.parentElement;
          }, targetParentBlockId),
        ).toBe(true);
        const moreTargetProperties = targetWindowPanel.getByRole("button", {
          name: /\d+ more propert(?:y|ies)/u,
        });
        if (await moreTargetProperties.isVisible()) await moreTargetProperties.click();
        await expect(
          targetWindowPanel.getByRole("button", { name: "Open 2 Files shown in Page" }),
        ).toBeVisible();
        await expect(targetPage.getByText("Image unavailable", { exact: true })).toHaveCount(0);

        await targetWindowParent.locator(":scope > .bn-block-content").click();
        await targetPage.keyboard.press("End");
        await targetPage.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+v`);
        await expect(movedImages).toHaveCount(2, { timeout: 15_000 });
        const pastedBlockIds = await movedImages.evaluateAll((images) =>
          images.map((image) => image.closest<HTMLElement>(".bn-block[data-id]")?.dataset.id ?? ""),
        );
        expect(pastedBlockIds).toContain(sourceImageBlockId);
        expect(pastedBlockIds.every(Boolean)).toBe(true);
        expect(new Set(pastedBlockIds).size).toBe(2);
        const afterSecondPaste = await readConvergencePageFiles(
          page,
          project.projectId,
          target.pageId,
        );
        expect(afterSecondPaste.liveTotal).toBe(2);
        expect(afterSecondPaste.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              fileId: sourceFileId,
              ownerPageId: target.pageId,
              bodyUsage: { kind: "placed", placementCount: 2 },
            }),
          ]),
        );

        await targetPage.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+z`);
        await expect(movedImages).toHaveCount(1, { timeout: 15_000 });
        await targetPage.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+z`);
        await expect(movedImages).toHaveCount(0, { timeout: 15_000 });
        await page.getByRole("tab", { name: "Exclusive source Page" }).click();
        await expect(sourceParent).toHaveCount(1, { timeout: 15_000 });
        const restoredImage = sourceSurface.locator(
          `[data-content-type="image"][data-url="${sourceFileUrl}"]`,
        );
        await expect(restoredImage.locator("img")).toHaveAttribute(
          "src",
          /^(?:blob:|data:image\/png;base64,)/u,
          { timeout: 15_000 },
        );
        await expect
          .poll(
            async () => ({
              source: await readConvergencePageFiles(page, project.projectId, source.pageId),
              target: await readConvergencePageFiles(page, project.projectId, target.pageId),
            }),
            { timeout: 15_000 },
          )
          .toMatchObject({
            source: {
              liveTotal: 1,
              files: [
                {
                  fileId: sourceFileId,
                  ownerPageId: source.pageId,
                  logicalPath: "image (2).png",
                  bodyUsage: { kind: "placed", placementCount: 1 },
                },
              ],
            },
            target: { liveTotal: 1 },
          });
        await expect(page.getByText("Image unavailable", { exact: true })).toHaveCount(0);
      } finally {
        await harness.application.evaluate(({ clipboard, nativeImage }, saved) => {
          clipboard.write({
            html: saved.html,
            image: nativeImage.createFromDataURL(saved.image),
            text: saved.text,
          });
        }, savedClipboard);
      }
    } finally {
      await harness.close();
    }
  });

  test("opens and pointer-reorders a nested List subtree without changing its internal parent @list-dnd-smoke", async () => {
    test.setTimeout(120_000);
    const harness = await ElectronScenarioHarness.create({ label: "list-dnd" });
    const workspace = harness.profile.initialProjectsDirectory;
    try {
      const page = await harness.launch();

      const project = await createConvergenceProject(page, "Native List DnD smoke", workspace);
      const firstTitle = "List fixture one";
      const firstFixture = await createConvergenceBoardPage(
        page,
        project,
        firstTitle,
        "First List Page",
      );
      const secondFixture = await createConvergenceBoardPage(
        page,
        project,
        "List fixture two",
        "Second List Page",
      );
      const thirdFixture = await createConvergenceBoardPage(
        page,
        project,
        "List fixture three",
        "Third List Page",
      );
      const listDescriptor = requireIpcValue<{ readonly dataSourceId: string }>(
        await invokeIpc(page, "database:list-window:get", project.projectId, {
          databaseViewId: project.defaultDatabaseViewId,
          first: 50,
        }),
        "Read List Data Source",
      );
      await requireIpcValue(
        await invokeIpc(page, "database-module:apply", project.projectId, {
          operationId: createUuidV7(),
          projectId: project.projectId,
          storeEpoch: project.storeEpoch,
          actor: { kind: "electron_e2e" },
          operations: [
            {
              kind: "set_task_parent",
              dataSourceId: listDescriptor.dataSourceId,
              pages: [
                {
                  pageId: secondFixture.pageId,
                  expectedValueRevision: 1,
                },
              ],
              parentPageId: firstFixture.pageId,
            },
            {
              kind: "put_view_personal_presentation",
              viewId: project.defaultDatabaseViewId,
              expectedRevision: 0,
              presentationOverride: {
                hierarchy: { showSubPages: true, nestedSubPages: true },
              },
            },
          ],
        }),
        "Nest List child fixture",
      );

      await page
        .getByRole("button", {
          name: "Open Native List DnD smoke",
          exact: true,
        })
        .click();
      const board = page.locator("[data-board-column-root]").first();
      await expect(board).toBeVisible({ timeout: 15_000 });
      await page
        .getByRole("tablist", { name: "Database views" })
        .getByRole("tab", { name: "List", exact: true })
        .click();

      const grid = page.getByRole("grid", { name: /List$/ });
      await expect(grid).toBeVisible({ timeout: 15_000 });
      const rows = grid.locator('[data-list-row="true"][data-database-view-page-id]');
      for (const fixture of [firstFixture, secondFixture, thirdFixture]) {
        await expect(
          grid.locator(`[data-list-row="true"][data-database-view-page-id="${fixture.pageId}"]`),
        ).toHaveCount(1, { timeout: 15_000 });
      }
      const fixturePageIds = [firstFixture.pageId, secondFixture.pageId, thirdFixture.pageId];
      let initialOrder: string[] = [];
      await expect
        .poll(
          async () => {
            initialOrder = await rows.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-database-view-page-id") ?? ""),
            );
            return initialOrder;
          },
          { timeout: 15_000 },
        )
        .toEqual(expect.arrayContaining(fixturePageIds));
      const sourcePageId = firstFixture.pageId;
      const childPageId = secondFixture.pageId;
      const targetPageId = thirdFixture.pageId;
      const sourceRow = grid.locator(
        `[data-list-row="true"][data-database-view-page-id="${sourcePageId}"]`,
      );
      const targetRow = grid.locator(
        `[data-list-row="true"][data-database-view-page-id="${targetPageId}"]`,
      );

      await dragListRowWithMouse({
        page,
        sourceRow,
        targetRow,
        position: "center",
        expectedOverlayCount: 2,
      });

      const orderWithoutSource = initialOrder.filter(
        (pageId) => pageId !== sourcePageId && pageId !== childPageId,
      );
      const targetIndex = orderWithoutSource.indexOf(targetPageId);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      const expectedOrder = [
        ...orderWithoutSource.slice(0, targetIndex + 1),
        sourcePageId,
        childPageId,
        ...orderWithoutSource.slice(targetIndex + 1),
      ];
      await expect
        .poll(
          async () =>
            await rows.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-database-view-page-id") ?? ""),
            ),
          { timeout: 15_000 },
        )
        .toEqual(expectedOrder);
      await expect
        .poll(
          async () => {
            const result = requireIpcValue<{
              readonly rows: readonly {
                readonly kind: string;
                readonly row?: {
                  readonly page?: { readonly pageId?: string };
                  readonly taskParent?: { readonly parentPageId?: string | null };
                };
              }[];
            }>(
              await invokeIpc(page, "database:list-window:get", project.projectId, {
                databaseViewId: project.defaultDatabaseViewId,
                first: 50,
                presentationOverride: {
                  layout: "list",
                  hierarchy: { showSubPages: true, nestedSubPages: true },
                },
              }),
              "Read reordered List window",
            );
            const order = result.rows.flatMap((row) =>
              row.kind === "page" && row.row?.page?.pageId ? [row.row.page.pageId] : [],
            );
            const source = result.rows.find(
              (row) => row.kind === "page" && row.row?.page?.pageId === sourcePageId,
            );
            const child = result.rows.find(
              (row) => row.kind === "page" && row.row?.page?.pageId === childPageId,
            );
            return {
              order,
              sourceParentPageId: source?.row?.taskParent?.parentPageId ?? null,
              childParentPageId: child?.row?.taskParent?.parentPageId ?? null,
            };
          },
          { timeout: 15_000 },
        )
        .toEqual({
          order: expectedOrder,
          sourceParentPageId: null,
          childParentPageId: sourcePageId,
        });

      await targetRow.locator('[data-list-grid-column="indent"]').click();
      const pageStage = page.locator('[data-page-stage-surface="true"]:visible');
      await expect(pageStage).toBeVisible({ timeout: 15_000 });
      await expect(pageStage.getByRole("textbox", { name: "Page title" })).toHaveText(
        "List fixture three",
        { timeout: 15_000 },
      );
      await expect(page.locator('[data-slot="toast-item"] [role="alert"]')).toHaveCount(0);
    } finally {
      await harness.close();
    }
  });
});

test("keeps Page ready and idle CPU bounded with 14k LocalCommit history @performance", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const harness = await ElectronScenarioHarness.create({ label: "page-ready-pressure" });
  const nodexHome = harness.profile.nodexHome;
  const workspace = harness.profile.initialProjectsDirectory;
  try {
    const setupPage = await harness.launch();
    const project = await createConvergenceProject(
      setupPage,
      "Large history Page ready",
      workspace,
    );
    const fixturePages: Array<ConvergencePage & { readonly title: string }> = [];
    for (let round = 0; round < PAGE_READY_ROUNDS; round += 1) {
      const title = `History Page ${round.toString().padStart(2, "0")}`;
      fixturePages.push({
        ...(await createConvergenceBoardPage(
          setupPage,
          project,
          title,
          `Deterministic Page-ready fixture ${round}`,
        )),
        title,
      });
    }

    await harness.stopCoreForOfflineFixture();
    const history = seedSyntheticLocalCommitHistory(nodexHome, PAGE_READY_HISTORY_COMMITS);
    expect(history).toMatchObject({
      commitCountAfter: PAGE_READY_HISTORY_COMMITS,
    });

    const page = await harness.launch();
    const application = harness.application;
    await page.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __nodexPageReadyLongTasks?: number[];
      };
      target.__nodexPageReadyLongTasks = [];
      if (typeof PerformanceObserver === "undefined") return;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          target.__nodexPageReadyLongTasks?.push(entry.duration);
        }
      });
      observer.observe({ type: "longtask", buffered: true });
    });
    const coreClient = await CoreClient.connect({
      nodexHome,
      clientKind: "test",
      buildId: "page-ready-history-e2e",
      requestTimeoutMs: 60_000,
    });
    const healthBefore = await coreClient.health();
    expect(healthBefore.metrics.commit_head).toBeGreaterThanOrEqual(history.commitHeadAfter);

    await page
      .getByRole("button", {
        name: "Open Large history Page ready",
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: "Project Home" }).waitFor();
    await expect
      .poll(async () => await page.locator("[data-board-uuid-v7]").count(), { timeout: 15_000 })
      .toBe(PAGE_READY_ROUNDS);

    const pageReadySamples: Array<{
      readonly cold: boolean;
      readonly durationMs: number;
      readonly round: number;
    }> = [];
    for (const [round, fixturePage] of fixturePages.entries()) {
      const card = page.locator(`[data-board-uuid-v7="${fixturePage.pageId}"]`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await page.evaluate((loadingLabel) => {
        const target = globalThis as typeof globalThis & {
          __nodexPageReadyMeasurement?: {
            durationMs: number | null;
            skeletonAt: number | null;
            startedAt: number;
          };
        };
        const measurement: {
          durationMs: number | null;
          skeletonAt: number | null;
          startedAt: number;
        } = {
          durationMs: null,
          skeletonAt: null,
          startedAt: performance.now(),
        };
        target.__nodexPageReadyMeasurement = measurement;
        const sample = (): boolean => {
          if (
            measurement.skeletonAt === null &&
            [...document.querySelectorAll<HTMLElement>('[role="status"][aria-busy="true"]')].some(
              (status) => status.getAttribute("aria-label") === loadingLabel,
            )
          ) {
            measurement.skeletonAt = performance.now();
          }
          if (measurement.skeletonAt === null) return false;
          const editor = document.querySelector(
            '[data-page-stage-surface="true"] ' +
              '.nfm-editor .ProseMirror[contenteditable="true"]',
          );
          if (!editor) return false;
          measurement.durationMs = performance.now() - measurement.skeletonAt;
          return true;
        };
        const observer = new MutationObserver(() => {
          if (sample()) observer.disconnect();
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
        if (sample()) observer.disconnect();
      }, `Loading ${fixturePage.title}`);
      await card.click({ force: true });
      await expect
        .poll(
          async () =>
            await page.evaluate(
              () =>
                (
                  globalThis as typeof globalThis & {
                    __nodexPageReadyMeasurement?: { durationMs: number | null };
                  }
                ).__nodexPageReadyMeasurement?.durationMs ?? null,
            ),
          {
            timeout: 15_000,
          },
        )
        .not.toBeNull();
      const durationMs = await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __nodexPageReadyMeasurement?: { durationMs: number | null };
            }
          ).__nodexPageReadyMeasurement?.durationMs ?? Number.NaN,
      );
      if (!Number.isFinite(durationMs)) {
        throw new Error("Page editor readiness measurement is missing");
      }
      await page.getByRole("tab", { name: fixturePage.title, exact: true }).waitFor();
      const editor = page
        .locator(
          '[data-page-stage-surface="true"]:visible ' +
            '.nfm-editor .ProseMirror[contenteditable="true"]',
        )
        .last();
      await expect(editor).toBeVisible({ timeout: 15_000 });
      pageReadySamples.push({
        cold: round === 0,
        durationMs,
        round,
      });
      await page
        .getByRole("button", {
          name: `Close ${fixturePage.title} tab`,
          exact: true,
        })
        .click({ force: true });
      await expect(
        page.getByRole("tab", {
          name: fixturePage.title,
          exact: true,
        }),
      ).toHaveCount(0);
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });
      await page.waitForTimeout(100);
    }
    const pageReadySummary = summarizeDurations(
      pageReadySamples.map((sample) => sample.durationMs),
    );
    const normalizedOneMinuteLoad = os.loadavg()[0] / Math.max(1, os.cpus().length);
    const noisyEnvironment = normalizedOneMinuteLoad >= 1;
    const frozenBaselineUpperBoundMs = 92;
    const medianDeltaRatio =
      (pageReadySummary.p50 - frozenBaselineUpperBoundMs) / frozenBaselineUpperBoundMs;
    const enforcePerformanceGates = process.env.NODEX_SKIP_PERFORMANCE_GATES !== "1";
    console.info(`[page-ready-samples] ${JSON.stringify(pageReadySamples)}`);
    if (enforcePerformanceGates) {
      if (noisyEnvironment) {
        expect(medianDeltaRatio).toBeLessThanOrEqual(0.1);
      } else {
        expect(pageReadySummary.p95).toBeLessThanOrEqual(150);
      }
    }

    await page.waitForTimeout(2_000);
    const electronCpuBefore = await readElectronProcessCpu(application);
    const coreCpuBefore = readProcessCpuTime(coreClient.handshake.generation.pid);
    const coreCpuPercentSamples: number[] = [];
    const electronCpuPercentSamples: Array<readonly ElectronProcessCpuSample[]> = [];
    for (let second = 0; second < IDLE_CPU_SAMPLE_SECONDS; second += 1) {
      coreCpuPercentSamples.push(readProcessCpuPercent(coreClient.handshake.generation.pid));
      electronCpuPercentSamples.push(await readElectronProcessCpu(application));
      await page.waitForTimeout(1_000);
    }
    const coreCpuAfter = readProcessCpuTime(coreClient.handshake.generation.pid);
    const electronCpuAfter = await readElectronProcessCpu(application);
    const healthAfter = await coreClient.health();
    const coreCpuDeltaSeconds = Math.max(0, coreCpuAfter - coreCpuBefore);
    const electronCpuDeltaSeconds = cumulativeElectronCpuDelta(electronCpuBefore, electronCpuAfter);
    const coreAverageCores = coreCpuDeltaSeconds / IDLE_CPU_SAMPLE_SECONDS;
    if (enforcePerformanceGates) {
      expect(coreAverageCores).toBeLessThanOrEqual(0.05);
      expect(Math.max(0, ...coreCpuPercentSamples)).toBeLessThan(100);
    }
    expect(healthAfter.metrics.event_replay_lag_max).toBe(
      healthBefore.metrics.event_replay_lag_max,
    );
    expect(healthAfter.metrics.writer_queue_depth).toBe(0);
    expect(healthAfter.metrics.active_writer_commands).toBe(0);

    const rendererLongTasks = await page.evaluate(() => [
      ...((
        globalThis as typeof globalThis & {
          __nodexPageReadyLongTasks?: number[];
        }
      ).__nodexPageReadyLongTasks ?? []),
    ]);
    const appMetrics = await application.evaluate(({ app }) => app.getAppMetrics());
    const metrics = {
      capturedAt: new Date().toISOString(),
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
      buildMode: process.env.NODEX_CORE_EXECUTABLE?.includes("/release/")
        ? "electron-test-release-core"
        : "electron-test-debug-core",
      fixtureSeed: "page-ready-v1-20-pages-14419-local-commits",
      hardware: {
        architecture: process.arch,
        cpuCount: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        osRelease: os.release(),
        platform: process.platform,
        totalMemoryBytes: os.totalmem(),
        normalizedOneMinuteLoad,
      },
      history,
      pageReady: {
        samples: pageReadySamples,
        p50Ms: pageReadySummary.p50,
        p95Ms: pageReadySummary.p95,
        maxMs: pageReadySummary.max,
        preCommitP95UpperBoundMs: 92,
        allowedP95Ms: 112,
        absoluteGateMs: 150,
        medianDeltaRatio,
        noisyEnvironment,
        verdictBasis: noisyEnvironment ? "median-vs-frozen-pre-commit-upper-bound" : "p95",
      },
      globalReplay: {
        eventReplayLagMaxBefore: healthBefore.metrics.event_replay_lag_max,
        eventReplayLagMaxAfter: healthAfter.metrics.event_replay_lag_max,
        publicationCountBefore: healthBefore.metrics.local_commit_publication_duration.count,
        publicationCountAfter: healthAfter.metrics.local_commit_publication_duration.count,
      },
      idleCpu: {
        sampleSeconds: IDLE_CPU_SAMPLE_SECONDS,
        corePid: coreClient.handshake.generation.pid,
        coreCpuDeltaSeconds,
        coreAverageCores,
        corePercentSamples: coreCpuPercentSamples,
        electronCpuDeltaSeconds,
        aggregateCpuDeltaSeconds: coreCpuDeltaSeconds + electronCpuDeltaSeconds,
        electronPercentSamples: electronCpuPercentSamples,
      },
      renderer: {
        longTaskCount: rendererLongTasks.length,
        maxLongTaskMs: Math.max(0, ...rendererLongTasks),
        peakWorkingSetBytes: Math.max(
          0,
          ...appMetrics.map((metric) => metric.memory.peakWorkingSetSize * 1_024),
        ),
      },
      healthAfter: {
        activeDocumentSubscriptions: healthAfter.metrics.active_document_subscriptions,
        activeEventSubscriptions: healthAfter.metrics.active_event_subscriptions,
        activeReadCommands: healthAfter.metrics.active_read_commands,
        activeWriterCommands: healthAfter.metrics.active_writer_commands,
        documentCacheEntries: healthAfter.metrics.document_cache_entries,
        writerQueueDepth: healthAfter.metrics.writer_queue_depth,
      },
    };
    const metricsPath = testInfo.outputPath("page-ready-14k-history-raw.json");
    fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
    await testInfo.attach("page-ready-14k-history-raw", {
      path: metricsPath,
      contentType: "application/json",
    });
    console.info(
      `[page-ready-14k-history] ${JSON.stringify({
        coreAverageCores,
        pageReadyP95Ms: pageReadySummary.p95,
        pageReadyMaxMs: pageReadySummary.max,
      })}`,
    );
  } finally {
    await harness.close();
  }
});

test("converges a high-pressure Page promotion across tab groups and WebContents", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const harness = await ElectronScenarioHarness.create({ label: "cross-tab" });
  const workspace = harness.profile.initialProjectsDirectory;
  try {
    const page = await harness.launch();
    const application = harness.application;

    const project = await createConvergenceProject(page, "Cross-tab Board stress", workspace);
    const database = await readConvergenceDatabase(page, project);
    const initialTriageFixturePageCount = HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT - 1;
    const boardFixture = await createConvergencePage(page, project, "Board fixture seed");
    const seededBoard = await seedConvergenceDocument(
      page,
      project,
      boardFixture,
      buildBoardFixtureNfm(),
    );
    const boardTriageFixturePageIds = await transferBoardFixturePages(
      page,
      project,
      database,
      seededBoard.documentId,
      seededBoard.blockIds.slice(1, initialTriageFixturePageCount + 1),
      "triage",
      "Seed cross-tab Triage Pages",
    );
    const boardPlanFixturePageIds = await transferBoardFixturePages(
      page,
      project,
      database,
      seededBoard.documentId,
      seededBoard.blockIds.slice(initialTriageFixturePageCount + 1, HIGH_PRESSURE_BOARD_PAGE_COUNT),
      "plan",
      "Seed cross-tab Plan Pages",
    );
    expect(boardTriageFixturePageIds).toHaveLength(initialTriageFixturePageCount);
    expect(boardPlanFixturePageIds).toHaveLength(HIGH_PRESSURE_BOARD_PLAN_PAGE_COUNT);
    const triageAnchorPageId = requireString(
      boardTriageFixturePageIds[0],
      "Cross-tab Triage anchor Page id",
    );
    const source = await createConvergenceBoardPage(
      page,
      project,
      "Cross-tab source",
      buildHighPressureSourceNfm("title-A-cross-tab"),
    );
    const seededSource = await seedConvergenceDocument(
      page,
      project,
      source,
      buildHighPressureSourceNfm("title-A-cross-tab"),
    );
    expect(seededSource.blockIds).toHaveLength(
      HIGH_PRESSURE_SIBLING_BLOCK_COUNT * 2 + HIGH_PRESSURE_CHILD_BLOCK_COUNT + 1,
    );

    await page
      .getByRole("button", {
        name: "Open Cross-tab Board stress",
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: "Project Home" }).waitFor();
    const triageColumn = page.locator('[data-board-column-root][data-board-column-id="triage"]');
    await expect(triageColumn).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => await page.locator("[data-board-uuid-v7]").count(), { timeout: 15_000 })
      .toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT);

    const sourceCard = page.locator(`[data-board-uuid-v7="${source.pageId}"]`);
    await expect(sourceCard).toBeVisible({ timeout: 15_000 });
    await openBoardPageFromCard({ card: sourceCard, page, tabName: "Cross-tab source" });
    await expect(triageColumn).toBeVisible({ timeout: 15_000 });

    const sourceEditor = page.locator('.nfm-editor .ProseMirror[contenteditable="true"]').last();
    await expect(sourceEditor).toBeVisible({ timeout: 15_000 });
    const titleBlock = sourceEditor
      .locator(".bn-block[data-id]")
      .filter({
        hasText: "title-A-cross-tab",
      })
      .first();
    await expect(titleBlock).toBeVisible({ timeout: 15_000 });

    const audienceWindowOpened = application.waitForEvent("window");
    expect(await invokeIpc(page, "window:new", {})).toBe(true);
    const audiencePage = await audienceWindowOpened;
    await audiencePage.evaluate(() => window.api?.awaitInitialization?.());
    await audiencePage
      .getByRole("button", {
        name: "Open Cross-tab Board stress",
        exact: true,
      })
      .click();
    await audiencePage.getByRole("tab", { name: "Project Home" }).waitFor();
    const webContentsIds = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => window.webContents.id),
    );
    expect(new Set(webContentsIds).size).toBeGreaterThanOrEqual(2);

    const audienceTriageColumn = audiencePage.locator(
      '[data-board-column-root][data-board-column-id="triage"]',
    );
    await expect(audienceTriageColumn).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => await audiencePage.locator("[data-board-uuid-v7]").count(), {
        timeout: 15_000,
      })
      .toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT);
    const audienceSourceCard = audiencePage.locator(`[data-board-uuid-v7="${source.pageId}"]`);
    await expect(audienceSourceCard).toBeVisible({ timeout: 15_000 });
    await openBoardPageFromCard({
      card: audienceSourceCard,
      page: audiencePage,
      tabName: "Cross-tab source",
    });
    await expect(audienceTriageColumn).toBeVisible({ timeout: 15_000 });
    const audienceSourceEditor = audiencePage
      .locator('.nfm-editor .ProseMirror[contenteditable="true"]')
      .last();
    await expect(audienceSourceEditor).toBeVisible({ timeout: 15_000 });
    const audienceTitleBlock = audienceSourceEditor
      .locator(".bn-block[data-id]")
      .filter({ hasText: "title-A-cross-tab" })
      .first();
    await expect(audienceTitleBlock).toBeVisible({ timeout: 15_000 });

    const triageBeforeTransfer = requireIpcValue<Record<string, unknown>>(
      await invokeIpc(page, "database:view-window:get", project.projectId, {
        databaseViewId: database.viewId,
        groupScope: { kind: "path", groupKey: "triage", subgroupKey: null },
        first: HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT,
      }),
      "Read canonical Triage coordinate before cross-tab promotion",
    );
    const projectionBeforeTransfer = triageBeforeTransfer.projection;
    if (!isRecord(projectionBeforeTransfer)) {
      throw new Error("Canonical Triage window returned no projection coordinate");
    }

    await audiencePage.evaluate(() => {
      const target = globalThis as typeof globalThis & {
        __nodexRecipientDeliveries?: unknown[];
      };
      target.__nodexRecipientDeliveries = [];
      window.api?.on("recipient-delivery:message", (...args: unknown[]) => {
        target.__nodexRecipientDeliveries?.push(args[0]);
      });
    });

    const sourceDescriptorBefore = requireIpcValue<Record<string, unknown>>(
      await invokeIpc(page, "block-document:owned:prepare", project.projectId, source.pageId),
      "Read source Page Document before promotion",
    );
    const sourceGeneration = sourceDescriptorBefore.generation;
    const sourceHeadSeq = sourceDescriptorBefore.headSeq;
    if (typeof sourceGeneration !== "number" || typeof sourceHeadSeq !== "number") {
      throw new Error("Cross-tab source Page did not expose a causal Document head");
    }

    // Native pointer DnD has its dedicated isolated smoke above. Keep this
    // high-pressure gate at the renderer IPC mutation boundary while both real
    // destination/source surfaces remain mounted, then verify the complete
    // publication outcome without conflating gesture and convergence pressure.
    const startedAt = performance.now();
    const transferCommand = await invokeIpc(page, "blocks:transfer", project.projectId, {
      operationId: createUuidV7(),
      projectId: project.projectId,
      storeEpoch: project.storeEpoch,
      mode: "move",
      rootBlockIds: [seededSource.blockIds[HIGH_PRESSURE_SIBLING_BLOCK_COUNT]],
      causalDependencies: [
        {
          documentId: seededSource.documentId,
          generation: sourceGeneration,
          expectedHeadSeq: sourceHeadSeq,
        },
      ],
      source: { kind: "page", pageId: source.pageId },
      target: {
        kind: "data_source",
        dataSourceId: database.dataSourceId,
        placement: {
          kind: "direct",
          viewId: database.viewId,
          presentationOverride: { layout: "board" },
          groupKey: "triage",
          beforePageId: triageAnchorPageId,
        },
      },
      promotionPolicy: "literal",
    });
    const transfer = requireIpcValue<Record<string, unknown>>(
      transferCommand,
      "Promote title-A in the live cross-tab surfaces",
    );
    const committedAt = performance.now();
    const commitSeq = transfer.commitSeq;
    if (typeof commitSeq !== "number") {
      throw new Error("Cross-tab promotion returned no LocalCommit sequence");
    }
    expect(transferCommand).toMatchObject({
      ok: true,
      localCommit: {
        status: "committed",
        commit: { commit_seq: commitSeq },
        delivery: {
          projection_effects: expect.arrayContaining([
            expect.objectContaining({
              patch: expect.objectContaining({
                kind: "database_row_upsert",
                view_id: database.viewId,
              }),
            }),
          ]),
        },
      },
    });
    const localCommit = isRecord(transferCommand) ? transferCommand.localCommit : undefined;
    const delivery = isRecord(localCommit) ? localCommit.delivery : undefined;
    const effects =
      isRecord(delivery) && Array.isArray(delivery.projection_effects)
        ? delivery.projection_effects
        : [];
    const boardEffect = effects.find((effect) => {
      if (!isRecord(effect) || !isRecord(effect.patch)) return false;
      return (
        effect.patch.kind === "database_row_upsert" && effect.patch.view_id === database.viewId
      );
    });
    if (!isRecord(boardEffect)) {
      throw new Error("Cross-tab promotion returned no Board projection effect");
    }
    expect(boardEffect).toMatchObject({
      base_revision: projectionBeforeTransfer.revision,
      result_revision: Number(projectionBeforeTransfer.revision) + 1,
      scope: {
        canonical_key: projectionBeforeTransfer.scopeKey,
        schema_version: projectionBeforeTransfer.schemaVersion,
      },
    });
    if (!Array.isArray(transfer.resultRootBlockIds)) {
      throw new Error("Cross-tab promotion returned no result Page ids");
    }
    expect(transfer.resultRootBlockIds).toHaveLength(1);
    const resultPageId = requireString(
      transfer.resultRootBlockIds[0],
      "Cross-tab promoted Page id",
    );
    const groupsAfterTransfer = requireIpcValue<Record<string, unknown>>(
      await invokeIpc(page, "database:view-groups:get", project.projectId, {
        databaseViewId: database.viewId,
        minimumCommitSeq: commitSeq,
      }),
      "Read canonical Board totals after cross-tab promotion",
    );
    expect(groupsAfterTransfer.totalRows).toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT + 1);
    const triageAfterTransfer = requireIpcValue<Record<string, unknown>>(
      await invokeIpc(page, "database:view-window:get", project.projectId, {
        databaseViewId: database.viewId,
        groupScope: { kind: "path", groupKey: "triage", subgroupKey: null },
        first: HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT + 1,
        minimumCommitSeq: commitSeq,
      }),
      "Read canonical Triage window after cross-tab promotion",
    );
    expect(triageAfterTransfer.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          page: expect.objectContaining({ id: resultPageId }),
        }),
      ]),
    );
    try {
      await expect
        .poll(
          async () =>
            await audiencePage.evaluate((targetCommitSeq) => {
              const deliveries =
                (
                  globalThis as typeof globalThis & {
                    __nodexRecipientDeliveries?: Array<Record<string, unknown>>;
                  }
                ).__nodexRecipientDeliveries ?? [];
              return deliveries.some((delivery) => {
                const payload = delivery.payload as Record<string, unknown> | undefined;
                const packet = payload?.packet as Record<string, unknown> | undefined;
                const manifest = packet?.manifest as Record<string, unknown> | undefined;
                const identity = manifest?.identity as Record<string, unknown> | undefined;
                return payload?.kind === "packet" && identity?.commit_seq === targetCommitSeq;
              });
            }, commitSeq),
          { timeout: 5_000 },
        )
        .toBe(true);
    } catch (error) {
      const deliveries = await audiencePage.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __nodexRecipientDeliveries?: unknown[];
            }
          ).__nodexRecipientDeliveries ?? [],
      );
      console.info(`[cross-webcontents-recipient-deliveries] ${JSON.stringify(deliveries)}`);
      throw error;
    }
    const audienceAdmittedAt = performance.now();
    const recipientDeliverySummary = await audiencePage.evaluate((targetCommitSeq) => {
      const deliveries =
        (
          globalThis as typeof globalThis & {
            __nodexRecipientDeliveries?: Array<Record<string, unknown>>;
          }
        ).__nodexRecipientDeliveries ?? [];
      return deliveries.flatMap((delivery) => {
        const payload = delivery.payload as Record<string, unknown> | undefined;
        const packet = payload?.packet as Record<string, unknown> | undefined;
        const manifest = packet?.manifest as Record<string, unknown> | undefined;
        const identity = manifest?.identity as Record<string, unknown> | undefined;
        if (payload?.kind !== "packet" || identity?.commit_seq !== targetCommitSeq) {
          return [];
        }
        const effects = Array.isArray(packet?.projection_effects) ? packet.projection_effects : [];
        return effects.flatMap((candidate) => {
          if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
            return [];
          const effect = candidate as Record<string, unknown>;
          if (
            typeof effect.patch !== "object" ||
            effect.patch === null ||
            Array.isArray(effect.patch)
          )
            return [];
          const patch = effect.patch as Record<string, unknown>;
          return [
            {
              deliveryId: delivery.deliveryId,
              recipientLeaseId: delivery.recipientLeaseId,
              address: delivery.deliveryAddress,
              baseRevision: effect.base_revision,
              resultRevision: effect.result_revision,
              patchKind: patch.kind,
              viewId: patch.view_id,
            },
          ];
        });
      });
    }, commitSeq);
    expect(recipientDeliverySummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveryId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          recipientLeaseId: expect.stringMatching(/^[a-f0-9]{64}$/u),
          address: expect.objectContaining({
            kind: "project",
            project_id: project.projectId,
          }),
          patchKind: "database_row_upsert",
          viewId: database.viewId,
        }),
      ]),
    );
    const transferredCard = page
      .locator("[data-board-uuid-v7]")
      .filter({
        hasText: "title-A-cross-tab",
      })
      .first();
    const audienceTransferredCard = audiencePage
      .locator("[data-board-uuid-v7]")
      .filter({ hasText: "title-A-cross-tab" })
      .first();
    const [cardVisibleAt, sourceRemovedAt, audienceCardVisibleAt, audienceSourceRemovedAt] =
      await Promise.all([
        expect(transferredCard)
          .toBeVisible({ timeout: 15_000 })
          .then(async () => {
            await expect(transferredCard).toContainText("title-A-cross-tab");
            return performance.now();
          }),
        expect(titleBlock)
          .toHaveCount(0, { timeout: 15_000 })
          .then(() => performance.now()),
        expect(audienceTransferredCard)
          .toBeVisible({ timeout: 15_000 })
          .then(async () => {
            await expect(audienceTransferredCard).toContainText("title-A-cross-tab");
            return performance.now();
          }),
        expect(audienceTitleBlock)
          .toHaveCount(0, { timeout: 15_000 })
          .then(() => performance.now()),
      ]);
    const sourceDescriptorAfter = requireIpcValue<Record<string, unknown>>(
      await invokeIpc(page, "block-document:owned:prepare", project.projectId, source.pageId),
      "Read source Page Document after promotion",
    );
    expect(sourceDescriptorAfter).toMatchObject({
      documentId: seededSource.documentId,
      headSeq: expect.any(Number),
    });
    expect(sourceDescriptorAfter.headSeq).toBeGreaterThan(2);

    const detail = requireIpcValue<Record<string, unknown>>(
      await invokeIpc(page, "pages:detail:get", project.projectId, resultPageId),
      "Read cross-tab transferred Page detail",
    );
    expect(detail.page).toMatchObject({
      title: "title-A-cross-tab",
      parent: {
        kind: "data_source",
        dataSourceId: database.dataSourceId,
      },
    });
    expect(detail.page).toMatchObject({
      plainText: expect.stringContaining("child-placeholder-000"),
    });
    expect(detail.page).toMatchObject({
      plainText: expect.stringContaining("child-placeholder-099"),
    });
    expect(await sourceEditor.locator(".bn-block[data-id]").count()).toBe(
      HIGH_PRESSURE_SIBLING_BLOCK_COUNT * 2,
    );
    expect(await audienceSourceEditor.locator(".bn-block[data-id]").count()).toBe(
      HIGH_PRESSURE_SIBLING_BLOCK_COUNT * 2,
    );

    const metrics = {
      fixtureSeed: "cross-tab-board-transfer-v1-100x100x100",
      boardInitialPageCount: HIGH_PRESSURE_BOARD_PAGE_COUNT,
      sourceBlockCount: HIGH_PRESSURE_SIBLING_BLOCK_COUNT * 2 + HIGH_PRESSURE_CHILD_BLOCK_COUNT + 1,
      movedChildBlockCount: HIGH_PRESSURE_CHILD_BLOCK_COUNT,
      requestToCommitMs: committedAt - startedAt,
      commitToCardMs: cardVisibleAt - committedAt,
      commitToSourceRemovalMs: sourceRemovedAt - committedAt,
      commitToAudienceAdmissionObservedMs: audienceAdmittedAt - committedAt,
      commitToAudienceCardMs: audienceCardVisibleAt - committedAt,
      commitToAudienceSourceRemovalMs: audienceSourceRemovedAt - committedAt,
      requestToCardMs: cardVisibleAt - startedAt,
      requestToSourceRemovalMs: sourceRemovedAt - startedAt,
      transferPath: "origin-apply-response-plus-audience-scanner",
      webContentsCount: new Set(webContentsIds).size,
      commitSeq,
    };
    const metricsPath = testInfo.outputPath("cross-tab-transfer-performance.json");
    fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
    await testInfo.attach("cross-tab-transfer-performance", {
      path: metricsPath,
      contentType: "application/json",
    });
    console.info(`[cross-tab-transfer-performance] ${JSON.stringify(metrics)}`);
  } finally {
    await harness.close();
  }
});

test("measures high-pressure nested Block transfer into a populated Board @performance", async ({}, testInfo) => {
  test.setTimeout(HIGH_PRESSURE_TEST_TIMEOUT_MS);
  const keepFixture = process.env.NODEX_KEEP_BOARD_TRANSFER_FIXTURE === "1";
  const harness = await ElectronScenarioHarness.create({
    label: "board-stress",
    retention: keepFixture ? "keep" : "dispose",
  });
  const fixtureRoot = harness.profile.runRoot;
  const nodexHome = harness.profile.nodexHome;
  const workspace = harness.profile.initialProjectsDirectory;
  try {
    const page = await harness.launch();
    const application = harness.application;

    const project = await createConvergenceProject(page, "Board stress convergence", workspace);
    const fixturePreparationStartedAt = performance.now();
    const boardSeedPage = await createConvergencePage(page, project, "Board fixture seed");
    const seededBoard = await seedConvergenceDocument(
      page,
      project,
      boardSeedPage,
      buildBoardFixtureNfm(),
    );
    expect(seededBoard.blockIds).toHaveLength(HIGH_PRESSURE_BOARD_PAGE_COUNT + 1);
    const database = await readConvergenceDatabase(page, project);

    const boardFixtureRootBlockIds = seededBoard.blockIds.slice(1);
    const triageFixturePageIds = await transferBoardFixturePages(
      page,
      project,
      database,
      seededBoard.documentId,
      boardFixtureRootBlockIds.slice(0, HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT),
      "triage",
      "Create populated Triage fixture",
    );
    const planFixturePageIds = await transferBoardFixturePages(
      page,
      project,
      database,
      seededBoard.documentId,
      boardFixtureRootBlockIds.slice(HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT),
      "plan",
      "Create populated Plan fixture",
    );
    expect(triageFixturePageIds).toHaveLength(HIGH_PRESSURE_BOARD_TRIAGE_PAGE_COUNT);
    expect(planFixturePageIds).toHaveLength(HIGH_PRESSURE_BOARD_PLAN_PAGE_COUNT);
    const firstTriagePageId = requireString(
      triageFixturePageIds[0],
      "First Triage fixture Page id",
    );
    expect(await readConvergenceBoardTotal(page, project)).toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT);

    const blocksPerRound =
      HIGH_PRESSURE_SIBLING_BLOCK_COUNT * 2 + HIGH_PRESSURE_CHILD_BLOCK_COUNT + 1;
    const openProjectStartedAt = performance.now();
    await page
      .getByRole("button", {
        name: "Open Board stress convergence",
        exact: true,
      })
      .click();
    await page.getByRole("tab", { name: "Project Home" }).waitFor();
    const boardColumn = page.locator('[data-board-column-root][data-board-column-id="triage"]');
    await expect(boardColumn).toBeVisible({ timeout: 15_000 });
    const initialBoardCards = page.locator("[data-board-uuid-v7]");
    await expect
      .poll(async () => await initialBoardCards.count(), { timeout: 15_000 })
      .toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT);
    const boardInitialRenderMs = performance.now() - openProjectStartedAt;
    const initialDomNodes = await page.evaluate(() => document.getElementsByTagName("*").length);

    await page.evaluate(() => {
      const state = {
        longTasks: [] as number[],
      };
      Object.defineProperty(window, "__nodexBoardTransferPerformance", {
        configurable: true,
        value: state,
      });
      if (typeof PerformanceObserver === "undefined") return;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      });
      observer.observe({ type: "longtask", buffered: true });
    });

    const transferCommitDurations: number[] = [];
    const transferToSourceRemovalDurations: number[] = [];
    const transferToCardDurations: number[] = [];
    const normalizedOneMinuteLoads: number[] = [];
    const coreStageDurations = {} as Record<CoreTransferStage, number[]>;
    const coreStageObservationCounts = {} as Record<CoreTransferStage, number>;
    let firstTransferVisibilityFacts: BoardTransferPerformanceMetrics["firstTransferVisibilityFacts"] =
      [];
    let firstTransferVisibilityRows: BoardTransferPerformanceMetrics["firstTransferVisibilityRows"] =
      [];
    for (const stage of Object.keys(CORE_TRANSFER_STAGES) as CoreTransferStage[]) {
      coreStageDurations[stage] = [];
      coreStageObservationCounts[stage] = 0;
    }
    const metricsClient = await CoreClient.connect({
      nodexHome,
      clientKind: "test",
      buildId: "electron-e2e-performance",
      requestTimeoutMs: 15_000,
    });
    let lastChangeLogSeq = 0;
    for (let index = 0; index < HIGH_PRESSURE_ROUNDS; index += 1) {
      // Keep the renderer interactive while fixture pressure is applied. A
      // pre-open burst of twenty large document commits measures startup
      // backlog instead of the transfer path and can hide the Board surface
      // behind its own projection work.
      const sourcePage = await createConvergencePage(
        page,
        project,
        `High pressure source ${index + 1}`,
      );
      const seededSource = await seedConvergenceDocument(
        page,
        project,
        sourcePage,
        buildHighPressureSourceNfm(`title-A-${index}`),
      );
      expect(seededSource.blockIds).toHaveLength(blocksPerRound);
      const titleBlockId = seededSource.blockIds[HIGH_PRESSURE_SIBLING_BLOCK_COUNT];
      if (!titleBlockId) throw new Error("High-pressure source title Block is missing");
      const coreMetricsBefore = (await metricsClient.health()).metrics;
      normalizedOneMinuteLoads.push(os.loadavg()[0] / Math.max(1, os.cpus().length));
      const transferStartedAt = performance.now();
      const receipt = requireIpcValue<Record<string, unknown>>(
        await invokeIpc(page, "blocks:transfer", project.projectId, {
          operationId: createUuidV7(),
          projectId: project.projectId,
          storeEpoch: project.storeEpoch,
          mode: "move",
          rootBlockIds: [titleBlockId],
          causalDependencies: [],
          source: { kind: "document", documentId: seededSource.documentId },
          target: {
            kind: "data_source",
            dataSourceId: database.dataSourceId,
            placement: {
              kind: "direct",
              viewId: database.viewId,
              presentationOverride: { layout: "board" },
              groupKey: "triage",
              beforePageId: firstTriagePageId,
            },
          },
          promotionPolicy: "literal",
        }),
        `Transfer high-pressure title Block ${index + 1}`,
      );
      const transferCommittedAt = performance.now();
      const coreMetricsAfter = (await metricsClient.health()).metrics;
      for (const [stage, metricKey] of Object.entries(CORE_TRANSFER_STAGES) as Array<
        [CoreTransferStage, (typeof CORE_TRANSFER_STAGES)[CoreTransferStage]]
      >) {
        const delta = durationMetricDelta(coreMetricsBefore, coreMetricsAfter, metricKey);
        if (stage === "prepare" || stage === "apply") {
          expect(delta.observationCount).toBe(1);
        }
        coreStageDurations[stage].push(delta.durationMs);
        coreStageObservationCounts[stage] += delta.observationCount;
      }
      transferCommitDurations.push(transferCommittedAt - transferStartedAt);
      if (!Array.isArray(receipt.resultRootBlockIds)) {
        throw new Error("High-pressure Block transfer returned no result Page id");
      }
      const resultPageId = requireString(
        receipt.resultRootBlockIds[0],
        "High-pressure transferred Page id",
      );
      const commitSeq = receipt.commitSeq;
      if (typeof commitSeq !== "number") {
        throw new Error("High-pressure Block transfer returned no semantic commit sequence");
      }
      lastChangeLogSeq = commitSeq;
      if (index === 0) {
        firstTransferVisibilityFacts = readVisibilityFactCounts(nodexHome, commitSeq);
        firstTransferVisibilityRows = readVisibilityFactRows(nodexHome, commitSeq);
      }

      const evidence = Array.isArray(receipt.transformationEvidence)
        ? receipt.transformationEvidence.find(
            (entry) => isRecord(entry) && entry.sourceBlockId === titleBlockId,
          )
        : undefined;
      if (!isRecord(evidence)) {
        throw new Error("High-pressure Block transfer returned no title transformation evidence");
      }
      expect(evidence.kind).toBe("promote");
      expect(evidence.resultPageId).toBe(resultPageId);
      expect(evidence.bodyRootBlockIds).toHaveLength(HIGH_PRESSURE_CHILD_BLOCK_COUNT);

      const card = page.locator(`[data-board-uuid-v7="${resultPageId}"]`);
      const sourceObservation = invokeIpc(
        page,
        "pages:detail:get",
        project.projectId,
        sourcePage.pageId,
        commitSeq,
      ).then((value) => ({
        observedAt: performance.now(),
        sourceDetail: requireIpcValue<Record<string, unknown>>(
          value,
          `Read high-pressure source Page ${index + 1} after transfer`,
        ),
      }));
      const cardObservation = expect(card)
        .toBeVisible({ timeout: 15_000 })
        .then(async () => {
          await expect(card).toContainText(`title-A-${index}`);
          return performance.now();
        });
      const [{ observedAt: sourceObservedAt, sourceDetail }, cardVisibleAt] = await Promise.all([
        sourceObservation,
        cardObservation,
      ]);
      const sourcePageAfter = isRecord(sourceDetail.page) ? sourceDetail.page : null;
      const sourcePlainText = sourcePageAfter?.plainText;
      if (typeof sourcePlainText !== "string") {
        throw new Error("High-pressure source Page returned no plain text");
      }
      expect(sourcePlainText).toBe(HIGH_PRESSURE_SOURCE_REMAINDER);
      transferToSourceRemovalDurations.push(sourceObservedAt - transferCommittedAt);
      transferToCardDurations.push(cardVisibleAt - transferCommittedAt);

      if (index === 0) {
        const detail = requireIpcValue<Record<string, unknown>>(
          await invokeIpc(page, "pages:detail:get", project.projectId, resultPageId, commitSeq),
          "Read high-pressure transferred Page detail",
        );
        expect(detail.page).toMatchObject({
          title: "title-A-0",
          parent: {
            kind: "data_source",
            dataSourceId: database.dataSourceId,
          },
        });
        expect(detail.page).toMatchObject({
          plainText: expect.stringContaining("child-placeholder-000"),
        });
        expect(detail.page).toMatchObject({
          plainText: expect.stringContaining("child-placeholder-099"),
        });
      }
      await expect
        .poll(async () => await readConvergenceBoardTotal(page, project, commitSeq), {
          timeout: 15_000,
        })
        .toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT + index + 1);
    }
    expect(await readConvergenceBoardTotal(page, project, lastChangeLogSeq)).toBe(
      HIGH_PRESSURE_BOARD_PAGE_COUNT + HIGH_PRESSURE_ROUNDS,
    );
    const transferCommitSummary = summarizeDurations(transferCommitDurations);
    const transferToSourceRemovalSummary = summarizeDurations(transferToSourceRemovalDurations);
    const transferToCardSummary = summarizeDurations(transferToCardDurations);
    const coreStages = Object.fromEntries(
      Object.entries(coreStageDurations).map(([stage, durations]) => {
        const summary = summarizeDurations(durations);
        return [
          stage,
          {
            p50Ms: summary.p50,
            p95Ms: summary.p95,
            p99Ms: summary.p99,
            maxMs: summary.max,
            observationCount: coreStageObservationCounts[stage as CoreTransferStage],
          },
        ];
      }),
    ) as Record<CoreTransferStage, CoreTransferStageSummary>;

    const rendererMetrics = await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __nodexBoardTransferPerformance?: { longTasks: number[] };
        }
      ).__nodexBoardTransferPerformance;
      const longTasks = [...(state?.longTasks ?? [])];
      return {
        finalDomNodes: document.getElementsByTagName("*").length,
        rendererLongTaskCount: longTasks.length,
        rendererLongTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
        rendererMaxLongTaskMs: Math.max(0, ...longTasks),
      };
    });
    const peakWorkingSetBytes = await application.evaluate(({ app }) =>
      Math.max(0, ...app.getAppMetrics().map((metric) => metric.memory.peakWorkingSetSize * 1_024)),
    );
    const cpus = os.cpus();
    const metrics: BoardTransferPerformanceMetrics = {
      fixtureSeed: "board-transfer-v1-100x100x100",
      buildMode: process.env.NODEX_CORE_EXECUTABLE?.includes("/release/")
        ? "electron-test-release-core"
        : "electron-test-debug-core",
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpuModel: cpus[0]?.model ?? "unknown",
      cpuCount: cpus.length,
      totalMemoryBytes: os.totalmem(),
      normalizedOneMinuteLoadAtStart: normalizedOneMinuteLoads[0] ?? 0,
      normalizedOneMinuteLoadMax: Math.max(0, ...normalizedOneMinuteLoads),
      fixturePreparationMs: performance.now() - fixturePreparationStartedAt,
      boardInitialRenderMs,
      transferCommitMs: transferCommitSummary.p50,
      transferToSourceRemovalMs: transferToSourceRemovalSummary.p50,
      transferToCardMs: transferToCardSummary.p50,
      endToEndMs: transferCommitSummary.p50 + transferToCardSummary.p50,
      sourceBlockCount: blocksPerRound,
      movedChildBlockCount: HIGH_PRESSURE_CHILD_BLOCK_COUNT,
      initialBoardPageCount: HIGH_PRESSURE_BOARD_PAGE_COUNT,
      finalBoardPageCount: HIGH_PRESSURE_BOARD_PAGE_COUNT + HIGH_PRESSURE_ROUNDS,
      initialRenderedBoardCardCount: HIGH_PRESSURE_BOARD_PAGE_COUNT,
      finalRenderedBoardCardCount: await page.locator("[data-board-uuid-v7]").count(),
      initialDomNodes,
      ...rendererMetrics,
      peakWorkingSetBytes,
      firstTransferVisibilityFacts,
      firstTransferVisibilityRows,
      transferCommitP50Ms: transferCommitSummary.p50,
      transferCommitP95Ms: transferCommitSummary.p95,
      transferCommitP99Ms: transferCommitSummary.p99,
      transferCommitMaxMs: transferCommitSummary.max,
      transferToSourceRemovalP50Ms: transferToSourceRemovalSummary.p50,
      transferToSourceRemovalP95Ms: transferToSourceRemovalSummary.p95,
      transferToSourceRemovalP99Ms: transferToSourceRemovalSummary.p99,
      transferToSourceRemovalMaxMs: transferToSourceRemovalSummary.max,
      transferToCardP50Ms: transferToCardSummary.p50,
      transferToCardP95Ms: transferToCardSummary.p95,
      transferToCardP99Ms: transferToCardSummary.p99,
      transferToCardMaxMs: transferToCardSummary.max,
      coreStages,
      rawSamples: {
        transferCommitMs: transferCommitDurations,
        transferToSourceRemovalMs: transferToSourceRemovalDurations,
        transferToCardMs: transferToCardDurations,
        normalizedOneMinuteLoad: normalizedOneMinuteLoads,
        coreStages: coreStageDurations,
      },
      rounds: HIGH_PRESSURE_ROUNDS,
    };
    const metricsPath = testInfo.outputPath("board-transfer-high-pressure-metrics.json");
    fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
    await testInfo.attach("board-transfer-high-pressure-metrics", {
      path: metricsPath,
      contentType: "application/json",
    });
    console.info(`[board-transfer-high-pressure] ${JSON.stringify(metrics)}`);

    expect(metrics.initialBoardPageCount).toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT);
    expect(metrics.finalBoardPageCount).toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT + HIGH_PRESSURE_ROUNDS);
    expect(metrics.initialRenderedBoardCardCount).toBe(HIGH_PRESSURE_BOARD_PAGE_COUNT);
    expect(metrics.finalRenderedBoardCardCount).toBeGreaterThanOrEqual(
      metrics.initialRenderedBoardCardCount,
    );
    if (process.env.NODEX_SKIP_PERFORMANCE_GATES !== "1") {
      const isReleaseCore = metrics.buildMode === "electron-test-release-core";
      expect(metrics.transferCommitP95Ms).toBeLessThan(isReleaseCore ? 250 : 750);
      expect(metrics.transferToSourceRemovalP95Ms).toBeLessThan(100);
      expect(metrics.transferToCardP95Ms).toBeLessThan(100);
      if (isReleaseCore && metrics.rounds >= 100) {
        expect(metrics.transferCommitP99Ms).not.toBeNull();
        expect(metrics.transferCommitP99Ms ?? Number.POSITIVE_INFINITY).toBeLessThan(350);
        expect(metrics.transferToSourceRemovalP99Ms).not.toBeNull();
        expect(metrics.transferToSourceRemovalP99Ms ?? Number.POSITIVE_INFINITY).toBeLessThan(100);
        expect(metrics.transferToCardP99Ms).not.toBeNull();
        expect(metrics.transferToCardP99Ms ?? Number.POSITIVE_INFINITY).toBeLessThan(100);
      }
      expect(metrics.coreStages.writerQueueWait.p95Ms).toBeLessThan(5);
      expect(metrics.coreStages.prepare.p95Ms).toBeLessThan(50);
      expect(metrics.coreStages.packetPublication.p95Ms).toBeLessThan(5);
    }
  } finally {
    await harness.close();
    if (keepFixture) {
      console.info(`[board-transfer-fixture] ${fixtureRoot}`);
    }
  }
});

test("keeps representative large-content surfaces bounded in a real Electron renderer @performance", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-large-content-e2e-"));
  const builtFixtureDir = path.join(fixtureRoot, "renderer");
  const artifactDir = process.env.NODEX_LARGE_CONTENT_ARTIFACT_DIR
    ? path.resolve(process.env.NODEX_LARGE_CONTENT_ARTIFACT_DIR)
    : testInfo.outputPath("large-content-performance");
  fs.mkdirSync(artifactDir, { recursive: true });
  const fixtureFile = await buildLargeContentFixture(builtFixtureDir);

  let application: ElectronApplication | undefined;
  try {
    application = await launchLargeContentFixtureApplication();

    const scenarios: LargeContentScenario[] = ["workspace", "markdown", "tool", "startup"];
    const metrics: LargeContentScenarioMetrics[] = [];
    for (const scenario of scenarios) {
      metrics.push(
        await sampleLargeContentScenario({
          application,
          artifactDir,
          fixtureFile,
          scenario,
        }),
      );
    }

    fs.writeFileSync(
      path.join(artifactDir, "metrics.json"),
      `${JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          electron: process.versions.electron,
          fixtureSizes: LARGE_CONTENT_FIXTURE_SIZES,
          metrics,
        },
        null,
        2,
      )}\n`,
    );

    const byScenario = Object.fromEntries(metrics.map((metric) => [metric.scenario, metric]));
    const enforcePerformanceTiming = process.env.NODEX_SKIP_PERFORMANCE_GATES !== "1";
    if (enforcePerformanceTiming) {
      expect(byScenario.workspace?.maxLongTaskMs).toBeLessThanOrEqual(250);
      expect(byScenario.markdown?.maxLongTaskMs).toBeLessThanOrEqual(250);
      expect(byScenario.tool?.maxLongTaskMs).toBeLessThanOrEqual(250);
      expect(byScenario.startup?.maxLongTaskMs).toBeLessThanOrEqual(250);
    }
    expect(byScenario.workspace?.domNodes).toBeLessThanOrEqual(2_000);
    expect(byScenario.workspace?.accessibilityNodes).toBeLessThanOrEqual(2_000);
    expect(byScenario.markdown?.domNodes).toBeLessThanOrEqual(2_000);
    expect(byScenario.markdown?.accessibilityNodes).toBeLessThanOrEqual(2_000);
    expect(byScenario.tool?.domNodes).toBeLessThanOrEqual(2_000);
    expect(byScenario.tool?.accessibilityNodes).toBeLessThanOrEqual(2_000);
    expect(byScenario.startup?.domNodes).toBeLessThanOrEqual(2_000);
  } finally {
    if (application) await stopApplication(application);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
