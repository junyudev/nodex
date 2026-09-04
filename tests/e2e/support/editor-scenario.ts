import { expect, type Page } from "@playwright/test";
import type { DatabaseModuleReadSnapshotV2 } from "../../../src/shared/database-module-v2";
import {
  compilePageLifecycleRequestV2,
  type PageLifecyclePreflightSnapshotV2,
} from "../../../src/shared/page-lifecycle-v2-runtime";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../../src/shared/operation-identity";
import type { LibraryPageFileInventory } from "../../../src/shared/library-files";

export interface ConvergenceProject {
  projectId: string;
  storeEpoch: string;
  defaultDatabaseViewId: string;
}

export interface ConvergencePage {
  pageId: string;
  documentId: string;
}

/** New Projects have one Board; seed a separate List through the public Database boundary. */
export async function createConvergenceListView(
  page: Page,
  project: ConvergenceProject,
): Promise<string> {
  const snapshot = requireIpcValue<DatabaseModuleReadSnapshotV2>(
    await invokeIpc(page, "database-module:read", project.projectId, {
      projectId: project.projectId,
      read: { target: { kind: "view", viewId: project.defaultDatabaseViewId }, mode: "view" },
    }),
    "Read Board View for List fixture",
  );
  if (snapshot.value.kind !== "view") throw new Error("List fixture requires a Board View");
  const board = snapshot.value.value;
  const viewId = createUuidV7();
  requireIpcValue(
    await invokeIpc(page, "database-module:apply", project.projectId, {
      operationId: createUuidV7(),
      projectId: project.projectId,
      storeEpoch: project.storeEpoch,
      actor: { kind: "electron_e2e" },
      operations: [
        {
          kind: "duplicate_view",
          databaseId: board.databaseId,
          sourceViewId: board.viewId,
          expectedRevision: board.revision,
          newViewId: viewId,
        },
        {
          kind: "change_view_layout",
          databaseId: board.databaseId,
          viewId,
          expectedRevision: 1,
          layout: "list",
        },
      ],
    }),
    "Create List fixture",
  );
  return viewId;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requireString = (value: unknown, label: string): string => {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${label} is missing from the Electron E2E response`);
};

export const requireIpcValue = <T>(result: unknown, label: string): T => {
  if (!isRecord(result) || result.ok !== true || !("value" in result)) {
    const error =
      isRecord(result) && isRecord(result.error)
        ? String(result.error.message ?? "unknown IPC error")
        : "unknown IPC error";
    throw new Error(`${label} failed: ${error}`);
  }
  return result.value as T;
};

export async function invokeIpc(
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

export async function readConvergencePageFiles(
  page: Page,
  projectId: string,
  pageId: string,
): Promise<LibraryPageFileInventory> {
  const snapshot = requireIpcValue<Record<string, unknown>>(
    await invokeIpc(
      page,
      "library-module:read",
      { kind: "project", projectId },
      {
        read: {
          mode: "page_file_inventory",
          page_id: pageId,
          limit: 100,
        },
      },
    ),
    `Read Page Files for ${pageId}`,
  );
  const value = snapshot.value;
  if (!isRecord(value) || value.kind !== "page_file_inventory" || !isRecord(value.value)) {
    throw new Error(`Page Files for ${pageId} returned an unexpected value`);
  }
  return value.value as unknown as LibraryPageFileInventory;
}

export async function createConvergenceProject(
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

export async function createConvergencePage(
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

export async function createConvergenceBoardPage(
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

export interface SeededConvergencePage extends ConvergencePage {
  blockIds: readonly string[];
}

export async function seedConvergenceDocument(
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

export async function createConvergenceSubpage(
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
