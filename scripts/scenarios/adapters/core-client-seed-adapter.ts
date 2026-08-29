import {
  createCoreDocumentSyncAdapter,
  createCoreLibraryModuleAdapter,
  type RustDataAuthorityRuntime,
} from "../../../src/main/core-client";
import * as Effect from "effect/Effect";
import { compilePageLifecycleRequestV2 } from "../../../src/shared/page-lifecycle-v2-runtime";
import type {
  PageChatActivitySummaryResult,
  PageChatWindow,
  Project,
  ProjectCreateInput,
} from "../../../src/shared/types";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import type {
  SidebarSectionCreateInput,
  SidebarSectionMoveItemInput,
  SidebarSectionSessionCreateInput,
  SidebarSectionWindow,
} from "../../../src/shared/sidebar-sections";
import type {
  ScenarioBoardObservation,
  ScenarioDocumentReplacement,
  ScenarioPageObservation,
  ScenarioPageSeed,
  ScenarioRelatedChatSeed,
  ScenarioRelatedChatSeedResult,
  ScenarioSeedPort,
} from "../contracts";
import { normalizeScenarioBoardGroups } from "./normalize-board-groups";
import {
  ensurePrimaryDataSourcePropertyCount,
  readPrimaryDataSourcePropertyCount,
  type ScenarioDatabasePort,
} from "../seed/primary-data-source-properties";
import {
  runScenarioDatabase,
  runScenarioLibrary,
  runScenarioProjectWorkspace,
} from "./core-client-seed-runtime";

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

export class CoreClientSeedAdapter implements ScenarioSeedPort {
  readonly #runtime: RustDataAuthorityRuntime;
  readonly #libraryIdsByProject = new Map<string, string>();
  #bootstrap: Promise<void> | null = null;

  constructor(runtime: RustDataAuthorityRuntime) {
    this.#runtime = runtime;
  }

  async createProject(input: ProjectCreateInput): Promise<Project> {
    this.#bootstrap ??= this.#ensureInitialProject(input.sources?.[0]);
    await this.#bootstrap;
    const project = await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.createProject(input),
    );
    this.#libraryIdsByProject.set(project.id, project.libraryId);
    return project;
  }

  async createPage(input: ScenarioPageSeed): Promise<{ readonly documentId: string }> {
    const library = this.#library(input.projectId);
    const preflight = requireSuccess(
      await library.readPageLifecyclePreflight(input.projectId, input.pageId),
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
      await library.applyPageLifecycleMutation(request),
      `Create ${input.title}`,
    );
    return { documentId: receipt.documentId };
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

  async replaceOwnedDocument(
    input: ScenarioDocumentReplacement,
  ): Promise<{ readonly commitSeq: number }> {
    const documents = createCoreDocumentSyncAdapter(
      this.#runtime.clientForProject(input.projectId),
    );
    const descriptor = requireSuccess(
      await documents.prepareOwner({
        ownerBlockId: input.pageId,
        operationId: input.operationId,
        clientSessionId: input.clientSessionId,
      }),
      `Prepare ${input.pageId}`,
    );
    const mutation = requireSuccess(
      await documents.applyDocumentMutation({
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
    return { commitSeq: mutation.commitSeq };
  }

  async readPage(
    projectId: string,
    pageId: string,
    minimumCommitSeq?: number,
  ): Promise<ScenarioPageObservation> {
    const detail = requireSuccess(
      await runScenarioLibrary(this.#runtime, (library) =>
        library.readProjectPageDetail(projectId, pageId, minimumCommitSeq),
      ),
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
    const snapshot = await runScenarioDatabase(this.#runtime, (database) =>
      database.viewGroups(
        { kind: "project", projectId },
        {
          databaseViewId,
          ...(minimumCommitSeq === undefined ? {} : { minimumCommitSeq }),
        },
      ),
    );
    const groups = normalizeScenarioBoardGroups(snapshot);
    return { totalRows: snapshot.totalRows, commitSeq: snapshot.commitSeq, groups };
  }

  async createRelatedChat(input: ScenarioRelatedChatSeed): Promise<ScenarioRelatedChatSeedResult> {
    return await runScenarioProjectWorkspace(
      this.#runtime,
      Effect.fn("CoreClientSeedAdapter.createRelatedChat")(function* (workspace) {
        const session = yield* workspace.createProjectSession({
          projectId: input.projectId,
          noThreadFallbackTitle: input.noThreadFallbackTitle,
          initialPageIds: [...input.initialPageIds],
        });
        if (!input.thread) return { sessionId: session.id, threadId: null };
        const observedAt = Date.now();
        yield* workspace.upsertThread(input.thread.threadId, {
          projectId: input.projectId,
          threadSource: "user",
          threadName: input.thread.threadName,
          threadPreview: input.thread.threadPreview,
          modelProvider: "openai",
          status: {
            statusType: input.thread.statusType,
            activeFlags: [...input.thread.statusActiveFlags],
          },
          createdAt: observedAt,
          updatedAt: observedAt,
          recencyAt: observedAt,
        });
        yield* workspace.upsertProjectSessionThreadLink({
          sessionId: session.id,
          projectId: input.projectId,
          threadId: input.thread.threadId,
          threadSource: "user",
          threadName: input.thread.threadName,
          threadPreview: input.thread.threadPreview,
          modelProvider: "openai",
          statusType: input.thread.statusType,
          statusActiveFlags: [...input.thread.statusActiveFlags],
          createdAt: observedAt,
          updatedAt: observedAt,
          recencyAt: observedAt,
        });
        if (input.thread.unread) {
          yield* workspace.markProjectSessionUnread(session.id, { unread: true });
        }
        return { sessionId: session.id, threadId: input.thread.threadId };
      }),
    );
  }

  async readPageChatActivity(
    projectId: string,
    pageIds: readonly string[],
  ): Promise<PageChatActivitySummaryResult> {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.readPageChatActivitySummaries({
        pageAccessProjectId: projectId,
        pageIds: [...pageIds],
      }),
    );
  }

  async readPageChats(projectId: string, pageId: string): Promise<PageChatWindow> {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.listPageChatWindow({
        pageAccessProjectId: projectId,
        pageId,
        includeArchived: false,
        first: 50,
      }),
    );
  }

  async createSidebarSection(input: SidebarSectionCreateInput) {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.createSidebarSection(input),
    );
  }

  async createSessionInSidebarSection(input: SidebarSectionSessionCreateInput) {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.createSessionInSidebarSection(input),
    );
  }

  async moveSidebarSectionItem(input: SidebarSectionMoveItemInput): Promise<void> {
    await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.moveSidebarSectionItem(input),
    );
  }

  async listSidebarSections() {
    return await runScenarioProjectWorkspace(
      this.#runtime,
      Effect.fn("CoreClientSeedAdapter.listSidebarSections")(function* (workspace) {
        const items = [];
        let after: string | null = null;
        do {
          const window: SidebarSectionWindow = yield* workspace.listSidebarSections({
            after,
            first: 200,
          });
          items.push(...window.items);
          after = window.nextCursor;
        } while (after);
        return items;
      }),
    );
  }

  async listSidebarSectionItems(sectionId: string) {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.listSidebarSectionItems(sectionId, { first: 200 }),
    );
  }

  #library(projectId: string) {
    const libraryId = this.#libraryIdsByProject.get(projectId);
    if (!libraryId) {
      throw new Error(`Scenario Project ${projectId} was not created by this adapter`);
    }
    return createCoreLibraryModuleAdapter({
      client: this.#runtime.clientForProject(projectId),
      libraryId,
      profileId: this.#runtime.identity.profileId,
      storeEpoch: this.#runtime.identity.storeEpoch,
    });
  }

  #databasePort(): ScenarioDatabasePort {
    return {
      read: (request) => runScenarioDatabase(this.#runtime, (database) => database.read(request)),
      apply: (request) => runScenarioDatabase(this.#runtime, (database) => database.apply(request)),
    };
  }

  async #ensureInitialProject(sourceRoot?: string): Promise<void> {
    await runScenarioProjectWorkspace(
      this.#runtime,
      Effect.fn("CoreClientSeedAdapter.ensureInitialProject")(function* (workspace) {
        const bootstrap = yield* workspace.readProjectBootstrap;
        if (bootstrap.status === "ready") return;
        const projectId = createUuidV7();
        yield* workspace.createInitialProject({
          operationId: createUuidV7(),
          projectId,
          name: "Scenario Bootstrap",
          description: "",
          sources: sourceRoot ? [sourceRoot] : [],
          starterPage: {
            pageId: createUuidV7(),
            documentId: createUuidV7(),
            titleMarkdown: "Scenario Bootstrap",
            nfm: "Scenario bootstrap authority.",
          },
        });
      }),
    );
  }
}
