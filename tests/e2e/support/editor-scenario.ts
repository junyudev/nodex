import { expect, type Page } from "@playwright/test";
import * as Y from "yjs";
import { assertValidBlockDocument } from "../../../src/shared/block-documents/block-structure";
import { openPageDocument } from "../../../src/shared/block-documents/page-document";
import type { DatabaseModuleReadSnapshotV2 } from "../../../src/shared/database-module-v2";
import {
  compilePageLifecycleRequestV2,
  type PageLifecyclePreflightSnapshotV2,
} from "../../../src/shared/page-lifecycle-v2-runtime";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../../src/shared/operation-identity";
import type { LibraryPageFileInventory } from "../../../src/shared/library-files";
import type { IpcApi, IpcArgs } from "../../../src/shared/ipc-api";
import type { ProjectAccessedDocumentDescriptor } from "../../../src/shared/block-documents/contracts";
import { parseDatabaseViewId, type DatabaseViewId } from "../../../src/shared/database-identities";

export interface ConvergenceProject {
  projectId: string;
  storeEpoch: string;
  defaultDatabaseViewId: DatabaseViewId;
}

export interface ConvergencePage {
  pageId: string;
  documentId: string;
}

/** New Projects have one Board; seed a separate List through the public Database boundary. */
export async function createConvergenceListView(
  page: Page,
  project: ConvergenceProject,
): Promise<DatabaseViewId> {
  const snapshot = requireIpcValue<DatabaseModuleReadSnapshotV2>(
    await invokeIpc(page, "database-module:read", project.projectId, {
      projectId: project.projectId,
      read: { target: { kind: "view", viewId: project.defaultDatabaseViewId }, mode: "view" },
    }),
    "Read Board View for List fixture",
  );
  if (snapshot.value.kind !== "view") throw new Error("List fixture requires a Board View");
  const board = snapshot.value.value;
  const viewId = parseDatabaseViewId(createUuidV7());
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
  const listSnapshot = requireIpcValue<DatabaseModuleReadSnapshotV2>(
    await invokeIpc(page, "database-module:read", project.projectId, {
      projectId: project.projectId,
      read: { target: { kind: "view", viewId }, mode: "view" },
    }),
    "Read List fixture",
  );
  if (listSnapshot.value.kind !== "view") throw new Error("List fixture View is unavailable");
  const list = listSnapshot.value.value;
  requireIpcValue(
    await invokeIpc(page, "database-module:apply", project.projectId, {
      operationId: createUuidV7(),
      projectId: project.projectId,
      storeEpoch: project.storeEpoch,
      actor: { kind: "electron_e2e" },
      operations: [
        {
          kind: "put_view",
          databaseId: list.databaseId,
          dataSourceId: list.dataSourceId,
          viewId: list.viewId,
          expectedRevision: list.revision,
          name: "List",
          layout: "list",
          config: list.config,
          isDefault: false,
        },
      ],
    }),
    "Name List fixture",
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

export async function invokeIpc<Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcArgs<Channel>
): Promise<IpcApi[Channel]["result"]>;
export async function invokeIpc(
  page: Page,
  channel: keyof IpcApi,
  ...args: readonly unknown[]
): Promise<unknown> {
  return await page.evaluate(
    async ({ channel: targetChannel, args: targetArgs }) => {
      const invoke = window.api?.invoke as
        | ((target: string, ...targetArgs: readonly unknown[]) => Promise<unknown>)
        | undefined;
      return await invoke?.(targetChannel, ...targetArgs);
    },
    { channel: String(channel), args },
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
  const defaultDatabaseViewId = parseDatabaseViewId(project.defaultDatabaseViewId);
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

// Seed exact Nodex Markdown: blank lines separate Blocks; one newline stays inside a paragraph.
export async function seedConvergenceDocument(
  page: Page,
  project: ConvergenceProject,
  source: ConvergencePage,
  markdown = "Keep block\n\nDragged source",
): Promise<SeededConvergencePage> {
  const descriptor = requireIpcValue<ProjectAccessedDocumentDescriptor>(
    await invokeIpc(page, "block-document:owned:prepare", project.projectId, source.pageId),
    "Prepare source Page document",
  );
  const documentId = requireString(descriptor.documentId, "Source document id");
  if (documentId !== source.documentId) {
    throw new Error("Source Page document identity changed during preparation");
  }

  requireIpcValue(
    await invokeIpc(page, "block-documents:mutate", project.projectId, documentId, {
      mutationId: createUuidV7(),
      projectId: project.projectId,
      storeEpoch: project.storeEpoch,
      actor: {},
      documentId,
      generation: descriptor.generation,
      expectedHeadSeq: descriptor.headSeq,
      markdown,
    }),
    "Seed source Page document",
  );
  return { ...source, blockIds: await readConvergenceDocumentBlockIds(page, project, source) };
}

/** Read committed preorder, including Blocks retained by an exact Markdown write. */
export async function readConvergenceDocumentBlockIds(
  page: Page,
  project: ConvergenceProject,
  source: ConvergencePage,
): Promise<readonly string[]> {
  const documentId = source.documentId;
  const update = await page.evaluate(
    async (request) => {
      const api = window.api;
      if (!api) throw new Error("Development renderer bridge is unavailable");
      const subscribed = (await api.invoke(
        "document-sync:subscribe",
        request,
      )) as IpcApi["document-sync:subscribe"]["result"];
      if (!subscribed.ok) throw new Error(subscribed.error.message);
      try {
        const synced = (await api.invoke("document-sync:sync", {
          ...request,
          stateVector: new Uint8Array([0]),
        })) as IpcApi["document-sync:sync"]["result"];
        if (!synced.ok) throw new Error(synced.error.message);
        return Array.from(synced.value.update);
      } finally {
        await api.invoke("document-sync:unsubscribe", request);
      }
    },
    { projectId: project.projectId, documentId, clientSessionId: createUuidV7() },
  );
  const document = new Y.Doc({ guid: documentId });
  try {
    Y.applyUpdate(document, new Uint8Array(update));
    const blockIds = assertValidBlockDocument(openPageDocument(document).body).map(({ id }) => id);
    if (blockIds.length < 2) {
      throw new Error("Seed source Page document must contain a transferable block");
    }
    return blockIds;
  } finally {
    document.destroy();
  }
}

export async function createConvergenceSubpage(
  page: Page,
  project: ConvergenceProject,
  parent: ConvergencePage,
  title: string,
  beforeBlockId: string,
): Promise<ConvergencePage> {
  const descriptor = requireIpcValue<ProjectAccessedDocumentDescriptor>(
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
