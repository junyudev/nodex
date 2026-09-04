import type { Page } from "playwright";

import type { CoreResult } from "../../../src/shared/core-result";
import type { IpcApi } from "../../../src/shared/ipc-api";
import { createBoundedOperationId } from "../../../src/shared/operation-identity";
import { compilePageLifecycleRequestV2 } from "../../../src/shared/page-lifecycle-v2-runtime";
import type {
  PageChatActivitySummaryResult,
  PageChatWindow,
  Project,
  ProjectCreateInput,
} from "../../../src/shared/types";
import type {
  ScenarioBoardObservation,
  ScenarioDocumentCheckpointSeed,
  ScenarioDocumentReplacement,
  ScenarioLibraryFileSeed,
  ScenarioPageObservation,
  ScenarioPageFileEntrySeed,
  ScenarioPageSeed,
  ScenarioRelatedChatSeed,
  ScenarioRelatedChatSeedResult,
  ScenarioSeedPort,
  ScenarioStandalonePageSeed,
} from "../contracts";
import type {
  SidebarSectionCreateInput,
  SidebarSectionMoveItemInput,
  SidebarSectionSessionCreateInput,
} from "../../../src/shared/sidebar-sections";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import { normalizeScenarioBoardGroups } from "./normalize-board-groups";
import {
  ensurePrimaryDataSourcePropertyCount,
  readPrimaryDataSourcePropertyCount,
  type ScenarioDatabasePort,
} from "../seed/primary-data-source-properties";

type IpcChannel = keyof IpcApi;

const unwrapCoreResult = <Value>(result: CoreResult<Value>, label: string): Value => {
  if (result.ok) return result.value;
  throw new Error(`${label} failed: ${result.error.message}`);
};

const requireSuccess = <Value>(
  result:
    | { readonly ok: true; readonly value: Value }
    | {
        readonly ok: false;
        readonly error: { readonly message: string };
      },
  label: string,
): Value => {
  if (result.ok) return result.value;
  throw new Error(`${label} failed: ${result.error.message}`);
};

export class RendererIpcSeedAdapter implements ScenarioSeedPort {
  readonly #page: Page;

  constructor(page: Page) {
    this.#page = page;
  }

  async #invoke<Channel extends IpcChannel>(
    channel: Channel,
    ...args: IpcApi[Channel]["args"]
  ): Promise<IpcApi[Channel]["result"]> {
    return (await this.#page.evaluate(
      async ({ targetChannel, targetArgs }) => {
        const api = (
          window as unknown as {
            api?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
          }
        ).api;
        if (!api) throw new Error("Nodex preload API is unavailable");
        return await api.invoke(targetChannel, ...(targetArgs as unknown[]));
      },
      { targetChannel: channel as string, targetArgs: args as unknown[] },
    )) as IpcApi[Channel]["result"];
  }

  async createProject(input: ProjectCreateInput): Promise<Project> {
    return unwrapCoreResult(
      await this.#invoke("projects:create", {
        operationId: createBoundedOperationId("scenario.project.create"),
        payload: { projectId: createUuidV7(), input },
      }),
      "Project creation",
    );
  }

  async createPage(input: ScenarioPageSeed): Promise<{ readonly documentId: string }> {
    const preflight = requireSuccess(
      await this.#invoke("pages:lifecycle:preflight", input.projectId, input.pageId),
      `Preflight ${input.title}`,
    );
    const request = compilePageLifecycleRequestV2({
      intent: {
        kind: "create",
        operationId: input.operationId,
        projectId: input.projectId,
        pageId: input.pageId,
        status: input.status,
        input: { id: input.pageId, title: input.title, description: input.nfm },
      },
      preflight,
    });
    const receipt = requireSuccess(
      await this.#invoke("pages:lifecycle:apply", input.projectId, request),
      `Create ${input.title}`,
    );
    return { documentId: receipt.documentId };
  }

  async createStandalonePage(input: ScenarioStandalonePageSeed): Promise<void> {
    const parent = input.parentPageId
      ? requireSuccess(
          await this.#invoke("block-document:owned:prepare", input.projectId, input.parentPageId),
          "Prepare parent Page",
        )
      : null;
    const metadata = requireSuccess(
      await this.#invoke(
        "library-module:read",
        { kind: "library" },
        { read: { mode: "metadata" } },
      ),
      "Read Library metadata",
    );
    requireSuccess(
      await this.#invoke(
        "library-module:apply",
        { kind: "library" },
        {
          operationId: input.operationId,
          storeEpoch: metadata.storeEpoch,
          operation: {
            kind: "create_page",
            pageId: input.pageId,
            documentId: input.documentId,
            title: input.title,
            parent:
              parent && input.parentPageId
                ? {
                    kind: "page",
                    pageId: input.parentPageId,
                    expectedDocumentGeneration: parent.generation,
                    expectedDocumentHeadSeq: parent.headSeq,
                    insertion: input.beforeBlockId
                      ? { kind: "before", anchorBlockId: input.beforeBlockId }
                      : { kind: "append" },
                  }
                : { kind: "library" },
          },
        },
      ),
      `Create standalone ${input.title}`,
    );
  }

  async createStandaloneCanvas(
    input: Parameters<ScenarioSeedPort["createStandaloneCanvas"]>[0],
  ): Promise<void> {
    const metadata = requireSuccess(
      await this.#invoke(
        "library-module:read",
        { kind: "library" },
        { read: { mode: "metadata" } },
      ),
      "Read Library metadata",
    );
    requireSuccess(
      await this.#invoke(
        "library-module:apply",
        { kind: "library" },
        {
          operationId: createUuidV7(),
          storeEpoch: metadata.storeEpoch,
          operation: {
            kind: "create_canvas",
            canvasId: input.canvasId,
            documentId: input.documentId,
            displayName: input.name,
            destination: { kind: "library" },
          },
        },
      ),
      "Create Canvas",
    );
  }

  #databasePort(): ScenarioDatabasePort {
    return {
      read: async (request) =>
        await this.#invoke("database-module:read", request.projectId, request),
      apply: async (request) =>
        await this.#invoke("database-module:apply", request.projectId, request),
    };
  }

  async ensurePrimaryDataSourcePropertyCount(
    projectId: string,
    count: number,
  ): Promise<{ readonly commitSeq: number; readonly propertyCount: number }> {
    return await ensurePrimaryDataSourcePropertyCount(this.#databasePort(), projectId, count);
  }

  async readPrimaryDataSourcePropertyCount(projectId: string): Promise<number> {
    return await readPrimaryDataSourcePropertyCount(this.#databasePort(), projectId);
  }

  async readDatabase(request: Parameters<ScenarioDatabasePort["read"]>[0]) {
    return await this.#databasePort().read(request);
  }

  async applyDatabase(request: Parameters<ScenarioDatabasePort["apply"]>[0]) {
    return await this.#databasePort().apply(request);
  }

  async replaceOwnedDocument(
    input: ScenarioDocumentReplacement,
  ): Promise<{ readonly commitSeq: number; readonly createdBlockIds: readonly string[] }> {
    const descriptor = requireSuccess(
      await this.#invoke("block-document:owned:prepare", input.projectId, input.pageId),
      `Prepare ${input.pageId}`,
    );
    const mutation = requireSuccess(
      await this.#invoke("block-documents:mutate", input.projectId, descriptor.documentId, {
        mutationId: input.mutationId,
        projectId: input.projectId,
        storeEpoch: descriptor.storeEpoch,
        clientSessionId: input.clientSessionId,
        actor: { kind: "scenario_seed" },
        documentId: descriptor.documentId,
        generation: descriptor.generation,
        expectedHeadSeq: descriptor.headSeq,
        nfm: input.nfm,
      }),
      `Replace ${input.pageId}`,
    );
    return { commitSeq: mutation.commitSeq, createdBlockIds: mutation.createdBlockIds };
  }

  async createLibraryFile(input: ScenarioLibraryFileSeed) {
    const access = { kind: "project" as const, projectId: input.projectId };
    const prepared = await this.#invoke("files:prepare", access, {
      operationId: input.operationId,
      source: {
        kind: "bytes",
        logicalPath: input.defaultName,
        mimeType: input.mimeType,
        bytes: input.bytes,
      },
    });
    const metadata = requireSuccess(
      await this.#invoke("library-module:read", access, { read: { mode: "metadata" } }),
      "Read Library metadata",
    );
    const result = requireSuccess(
      await this.#invoke("library-module:apply", access, {
        operationId: input.operationId,
        storeEpoch: metadata.storeEpoch,
        operation: {
          kind: "apply_file_change",
          change: {
            kind: "create",
            file_id: input.fileId,
            default_name: input.defaultName,
            mime_type: input.mimeType,
            prepared_blob_receipt_id: prepared.receiptId,
          },
        },
      }),
      `Create File ${input.defaultName}`,
    );
    const file = result.fileMutation?.file;
    if (!file || file.file_id !== input.fileId) {
      throw new Error(`Create File ${input.defaultName} omitted its committed File`);
    }
    return file;
  }

  async addPageFileEntry(input: ScenarioPageFileEntrySeed) {
    const access = { kind: "project" as const, projectId: input.projectId };
    const metadata = requireSuccess(
      await this.#invoke("library-module:read", access, { read: { mode: "metadata" } }),
      "Read Library metadata",
    );
    const result = requireSuccess(
      await this.#invoke("library-module:apply", access, {
        operationId: input.operationId,
        storeEpoch: metadata.storeEpoch,
        operation: {
          kind: "apply_page_file_entries",
          page_id: input.pageId,
          expected_manifest_revision: input.expectedManifestRevision,
          changes: [
            {
              kind: "attach",
              file_id: input.fileId,
              logical_path: input.logicalPath,
              source: { kind: "direct" },
              collision_policy: "reject",
            },
          ],
        },
      }),
      `Add ${input.logicalPath} to Page`,
    );
    const receipt = result.pageFileEntries?.find((item) => item.page_id === input.pageId);
    if (!receipt) throw new Error(`Add ${input.logicalPath} omitted its Page receipt`);
    return receipt;
  }

  async readPageFileInventory(projectId: string, pageId: string) {
    const result = requireSuccess(
      await this.#invoke(
        "library-module:read",
        { kind: "project", projectId },
        { read: { mode: "page_file_inventory", page_id: pageId, limit: 100 } },
      ),
      `Read Page Files for ${pageId}`,
    );
    if (result.value.kind !== "page_file_inventory") {
      throw new Error(`Read Page Files for ${pageId} returned an unexpected value`);
    }
    return result.value.value;
  }

  async createDocumentCheckpoint(input: ScenarioDocumentCheckpointSeed): Promise<string> {
    const descriptor = requireSuccess(
      await this.#invoke("block-document:owned:prepare", input.projectId, input.pageId),
      `Prepare checkpoint ${input.label}`,
    );
    if (descriptor.documentId !== input.documentId) {
      throw new Error(`Checkpoint ${input.label} resolved a different Document`);
    }
    const checkpoint = requireSuccess(
      await this.#invoke("block-documents:history:checkpoint", input.projectId, input.documentId, {
        operationId: input.operationId,
        projectId: input.projectId,
        storeEpoch: descriptor.storeEpoch,
        documentId: input.documentId,
        expectedGeneration: descriptor.generation,
        expectedHeadSeq: descriptor.headSeq,
        cause: "scenario_seed",
        label: input.label,
        actor: { kind: "scenario_seed" },
        revisionKind: "manual",
      }),
      `Create checkpoint ${input.label}`,
    );
    return checkpoint.checkpoint.versionId;
  }

  async readPage(
    projectId: string,
    pageId: string,
    minimumCommitSeq?: number,
  ): Promise<ScenarioPageObservation> {
    const detail = requireSuccess(
      await this.#invoke("pages:detail:get", projectId, pageId, minimumCommitSeq),
      `Read ${pageId}`,
    );
    return {
      pageId: detail.page.pageId,
      title: detail.page.title,
      descriptionPreview: detail.page.preview,
      documentReadiness: detail.document.readiness,
      commitSeq: detail.commitSeq,
    };
  }

  async readBoard(
    projectId: string,
    databaseViewId: string,
    minimumCommitSeq?: number,
  ): Promise<ScenarioBoardObservation> {
    const snapshot = unwrapCoreResult(
      await this.#invoke("database:view-groups:get", projectId, {
        databaseViewId,
        ...(minimumCommitSeq === undefined ? {} : { minimumCommitSeq }),
      }),
      "Read Board groups",
    );
    const groups = normalizeScenarioBoardGroups(snapshot);
    return { totalRows: snapshot.totalRows, commitSeq: snapshot.commitSeq, groups };
  }

  async createRelatedChat(input: ScenarioRelatedChatSeed): Promise<ScenarioRelatedChatSeedResult> {
    const session = unwrapCoreResult(
      await this.#invoke("project-sessions:create", {
        operationId: createBoundedOperationId("scenario.session.create"),
        payload: {
          sessionId: createUuidV7(),
          input: {
            projectId: input.projectId,
            noThreadFallbackTitle: input.noThreadFallbackTitle,
            initialPageIds: [...input.initialPageIds],
          },
        },
      }),
      "Session creation",
    );
    if (!input.thread) return { sessionId: session.id, threadId: null };
    const observedAt = Date.now();
    await this.#invoke("project-session-threads:attach", {
      sessionId: session.id,
      projectId: input.projectId,
      threadId: input.thread.threadId,
      threadSource: "user",
      threadName: input.thread.threadName,
      threadPreview: input.thread.threadPreview,
      backendBinding: { kind: "codex" },
      statusType: input.thread.statusType,
      statusActiveFlags: [...input.thread.statusActiveFlags],
      createdAt: observedAt,
      updatedAt: observedAt,
      recencyAt: observedAt,
    });
    if (input.thread.unread) {
      unwrapCoreResult(
        await this.#invoke("project-sessions:mark-unread", {
          operationId: createBoundedOperationId("scenario.session.mark-unread"),
          payload: { sessionId: session.id, unread: true },
        }),
        "Mark Session unread",
      );
    }
    return { sessionId: session.id, threadId: input.thread.threadId };
  }

  async readPageChatActivity(
    projectId: string,
    pageIds: readonly string[],
  ): Promise<PageChatActivitySummaryResult> {
    return await this.#invoke("page-chats:activity-summaries", {
      pageAccessProjectId: projectId,
      pageIds: [...pageIds],
    });
  }

  async readPageChats(projectId: string, pageId: string): Promise<PageChatWindow> {
    return await this.#invoke("page-chats:list", {
      pageAccessProjectId: projectId,
      pageId,
      includeArchived: false,
      first: 50,
    });
  }

  async createSidebarSection(input: SidebarSectionCreateInput) {
    return unwrapCoreResult(
      await this.#invoke("sidebar-sections:create", {
        operationId: createBoundedOperationId("scenario.sidebar-section.create"),
        payload: { sectionId: createUuidV7(), input },
      }),
      "Sidebar Section creation",
    );
  }

  async createSessionInSidebarSection(input: SidebarSectionSessionCreateInput) {
    return unwrapCoreResult(
      await this.#invoke("sidebar-sections:sessions:create", {
        operationId: createBoundedOperationId("scenario.sidebar-section.create-session"),
        payload: { sessionId: createUuidV7(), input },
      }),
      "Sidebar Section Session creation",
    );
  }

  async moveSidebarSectionItem(input: SidebarSectionMoveItemInput): Promise<void> {
    unwrapCoreResult(
      await this.#invoke("sidebar-sections:item:move", {
        operationId: createBoundedOperationId("scenario.sidebar-section.move-item"),
        payload: input,
      }),
      "Sidebar Section item move",
    );
  }

  async listSidebarSections() {
    const result = await this.#invoke("sidebar-sections:list", { first: 200 });
    return result.items;
  }

  async listSidebarSectionItems(sectionId: string) {
    return await this.#invoke("sidebar-sections:items:list", sectionId, { first: 200 });
  }
}
