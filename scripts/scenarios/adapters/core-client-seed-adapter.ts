import {
  createCoreDocumentSyncAdapter,
  createCoreLibraryModuleAdapter,
  type RustDataAuthorityRuntime,
} from "../../../src/main/core-client";
import * as Effect from "effect/Effect";
import * as Y from "yjs";
import { readPageBlockOutline } from "./page-block-outline";
import type { AutomationIntent, AutomationReadSnapshot } from "../../../src/main/core-client/types";
import {
  projectAutomationDefinition,
  toCoreAutomationDefinitionInput,
} from "../../../src/main/automation-application/AutomationProjection";
import { compilePageLifecycleRequestV2 } from "../../../src/shared/page-lifecycle-v2-runtime";
import { createBoundedOperationId } from "../../../src/shared/operation-identity";
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
import { normalizeScenarioBoardGroups } from "./normalize-board-groups";
import {
  ensurePrimaryDataSourcePropertyCount,
  readPrimaryDataSourcePropertyCount,
  type ScenarioDatabasePort,
} from "../seed/primary-data-source-properties";
import {
  runScenarioDatabase,
  runScenarioAutomation,
  runScenarioInbox,
  runScenarioLibrary,
  runScenarioProjectWorkspace,
} from "./core-client-seed-runtime";
import {
  LIBRARY_INBOX,
  type InboxScope,
  type InboxWindow,
  type InboxWindowFilter,
} from "../../../src/shared/inbox";
import type { ScenarioInboxDispatchSeed, ScenarioInboxProposalSeed } from "../contracts";
import { inboxPageBasisFromCore } from "../../../src/main/core-client/inbox-adapter";

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
    const { value: project } = await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.createProject({
        operationId: createBoundedOperationId("scenario.project.create"),
        payload: { projectId: createUuidV7(), input },
      }),
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
        input: { id: input.pageId, title: input.title, description: input.markdown },
      },
      preflight,
    });
    const receipt = requireSuccess(
      await library.applyPageLifecycleMutation(request),
      `Create ${input.title}`,
    );
    return { documentId: receipt.documentId };
  }

  async createStandalonePage(input: ScenarioStandalonePageSeed): Promise<void> {
    const parent = input.parentPageId
      ? requireSuccess(
          await createCoreDocumentSyncAdapter(
            this.#runtime.clientForProject(input.projectId),
          ).prepareOwner({
            ownerBlockId: input.parentPageId,
            operationId: createUuidV7(),
            clientSessionId: "scenario:child-page",
          }),
          "Prepare parent Page",
        )
      : null;
    const result = await this.#library(input.projectId).apply({
      operationId: input.operationId,
      storeEpoch: this.#runtime.identity.storeEpoch,
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
    });
    requireSuccess(result, `Create standalone ${input.title}`);
  }

  async createStandaloneCanvas(
    input: Parameters<ScenarioSeedPort["createStandaloneCanvas"]>[0],
  ): Promise<void> {
    requireSuccess(
      await this.#library(input.projectId).apply({
        operationId: createUuidV7(),
        storeEpoch: this.#runtime.identity.storeEpoch,
        operation: {
          kind: "create_canvas",
          canvasId: input.canvasId,
          documentId: input.documentId,
          displayName: input.name,
          destination: { kind: "library" },
        },
      }),
      "Create Canvas",
    );
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
        markdown: input.markdown,
      }),
      `Replace ${input.pageId}`,
    );
    return { commitSeq: mutation.commitSeq, createdBlockIds: mutation.createdBlockIds };
  }

  async readPageBlockTree(projectId: string, pageId: string) {
    const client = this.#runtime.clientForProject(projectId);
    const clientSessionId = createUuidV7();
    const descriptor = await createCoreDocumentSyncAdapter(client).readDescriptor({
      ownerBlockId: pageId,
      clientSessionId,
    });
    const document = new Y.Doc({ guid: descriptor.documentId });
    const stream = await client.openDocumentEventStream(
      { documentId: descriptor.documentId, clientSessionId },
      () => undefined,
      () => undefined,
      () => undefined,
    );
    try {
      const synced = requireSuccess(
        await createCoreDocumentSyncAdapter(client).sync({
          documentId: descriptor.documentId,
          clientSessionId,
          stateVector: Y.encodeStateVector(document),
        }),
        `Read ${pageId}`,
      );
      Y.applyUpdate(document, synced.update);
      return readPageBlockOutline(document);
    } finally {
      await stream.close();
      document.destroy();
    }
  }

  async createLibraryFile(input: ScenarioLibraryFileSeed) {
    const prepared = await this.#runtime.clientForProject(input.projectId).prepareFileBlob({
      operationId: input.operationId,
      bytes: input.bytes,
    });
    const result = requireSuccess(
      await this.#library(input.projectId).apply({
        operationId: input.operationId,
        storeEpoch: this.#runtime.identity.storeEpoch,
        operation: {
          kind: "apply_file_change",
          change: {
            kind: "create",
            file_id: input.fileId,
            default_name: input.defaultName,
            mime_type: input.mimeType,
            prepared_blob_receipt_id: prepared.receipt_id,
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
    const result = requireSuccess(
      await this.#library(input.projectId).apply({
        operationId: input.operationId,
        storeEpoch: this.#runtime.identity.storeEpoch,
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
      await this.#library(projectId).read({
        read: { mode: "page_file_inventory", page_id: pageId, limit: 100 },
      }),
      `Read Page Files for ${pageId}`,
    );
    if (result.value.kind !== "page_file_inventory") {
      throw new Error(`Read Page Files for ${pageId} returned an unexpected value`);
    }
    return result.value.value;
  }

  async createDocumentCheckpoint(input: ScenarioDocumentCheckpointSeed): Promise<string> {
    const documents = createCoreDocumentSyncAdapter(
      this.#runtime.clientForProject(input.projectId),
    );
    const descriptor = requireSuccess(
      await documents.prepareOwner({
        ownerBlockId: input.pageId,
        operationId: createUuidV7(),
        clientSessionId: "scenario:document-checkpoint",
      }),
      `Prepare checkpoint ${input.label}`,
    );
    if (descriptor.documentId !== input.documentId) {
      throw new Error(`Checkpoint ${input.label} resolved a different Document`);
    }
    const checkpoint = requireSuccess(
      await documents.createCheckpoint({
        operationId: input.operationId,
        projectId: input.projectId,
        storeEpoch: descriptor.storeEpoch,
        documentId: descriptor.documentId,
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
        const { value: session } = yield* workspace.createProjectSession({
          operationId: createBoundedOperationId("scenario.session.create"),
          payload: {
            sessionId: createUuidV7(),
            input: {
              projectId: input.projectId,
              noThreadFallbackTitle: input.noThreadFallbackTitle,
              initialPageIds: [...input.initialPageIds],
            },
          },
        });
        if (input.pinned) {
          yield* workspace.setProjectSessionPinned({
            operationId: createBoundedOperationId("scenario.session.pin"),
            payload: { sessionId: session.id, pinned: true },
          });
        }
        if (!input.thread) return { sessionId: session.id, threadId: null };
        const observedAt = Date.now();
        yield* workspace.upsertThread(input.thread.threadId, {
          projectId: input.projectId,
          threadSource: "user",
          threadName: input.thread.threadName,
          threadPreview: input.thread.threadPreview,
          backendBinding: { kind: "codex" },
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
          backendBinding: { kind: "codex" },
          statusType: input.thread.statusType,
          statusActiveFlags: [...input.thread.statusActiveFlags],
          createdAt: observedAt,
          updatedAt: observedAt,
          recencyAt: observedAt,
        });
        if (input.thread.unread) {
          yield* workspace.markProjectSessionUnread({
            operationId: createBoundedOperationId("scenario.session.mark-unread"),
            payload: { sessionId: session.id, unread: true },
          });
        }
        return { sessionId: session.id, threadId: input.thread.threadId };
      }),
    );
  }

  async sendInboxMessage(
    body: string,
    scope: InboxScope = LIBRARY_INBOX,
  ): Promise<{ readonly pageId: string }> {
    return await runScenarioInbox(
      this.#runtime,
      Effect.fn("Scenario.captureInbox")(function* (inbox) {
        const summary = yield* inbox.summary({ scope });
        const result = yield* inbox.send({
          scope,
          body,
          operationId: createBoundedOperationId("scenario.inbox.send"),
          pageId: createUuidV7(),
          documentId: createUuidV7(),
          issuedAt: Date.now(),
          storeEpoch: summary.storeEpoch,
        });
        return result.value;
      }),
    );
  }

  async prepareInboxSuggestions(automatic: boolean): Promise<void> {
    await runScenarioInbox(this.#runtime, (inbox) => inbox.prepareSuggestions(8, automatic));
  }

  async proposeInboxDispatch(input: ScenarioInboxProposalSeed): Promise<void> {
    await runScenarioInbox(
      this.#runtime,
      Effect.fn("CoreClientSeedAdapter.proposeInboxDispatch")(function* (inbox) {
        const context = yield* inbox.dispatchContext(input.pageIds);
        yield* inbox.propose({
          proposalId: createUuidV7(),
          pageIds: input.pageIds,
          basis: context.entries.map((entry) => entry.basis),
          action: input.action,
          kind: input.kind,
          summary: input.summary,
          rationale: input.rationale,
          producedBy: "Scenario",
        });
      }),
    );
  }

  async dispatchInboxEntries(input: ScenarioInboxDispatchSeed): Promise<void> {
    await runScenarioInbox(
      this.#runtime,
      Effect.fn("Scenario.dispatchInbox")(function* (inbox) {
        const context = yield* inbox.dispatchContext(input.pageIds);
        const summary = yield* inbox.summary({ scope: input.scope ?? LIBRARY_INBOX });
        const prepared = yield* inbox.prepareConfirmation({
          kind: "direct",
          pageIds: input.pageIds,
          storeEpoch: summary.storeEpoch,
          basis: context.entries.map((entry) => inboxPageBasisFromCore(entry.basis)),
          action: input.action,
        });
        if (prepared.kind !== "direct") throw new Error("Expected a direct Inbox decision");
        yield* inbox.dispatch({
          operationId: prepared.operationId,
          proposalId: prepared.proposalId,
          storeEpoch: prepared.storeEpoch,
          sessionId: prepared.sessionId,
          pageIds: prepared.pageIds,
          basis: prepared.basis,
          action: prepared.action,
          executionSelection: prepared.executionSelection,
        });
      }),
    );
  }

  async keepInboxEntries(pageIds: readonly string[]): Promise<void> {
    await runScenarioInbox(this.#runtime, (inbox) => inbox.keep({ pageIds }));
  }

  async recordInboxSuggestionFailure(pageIds: readonly string[], message: string): Promise<void> {
    await runScenarioInbox(this.#runtime, (inbox) =>
      inbox.recordSuggestionFailure(pageIds, message),
    );
  }

  async completeInboxDispatch(proposalId: string, threadId: string | null): Promise<void> {
    await runScenarioInbox(
      this.#runtime,
      Effect.fn("Scenario.completeInbox")(function* (inbox) {
        const work = (yield* inbox.outbox(16)).find((work) => work.proposal_id === proposalId);
        if (!work) throw new Error("Scenario confirmed dispatch is missing");
        yield* inbox.completeDispatch(work, threadId);
      }),
    );
  }

  async readInbox(
    filter: InboxWindowFilter,
    scope: InboxScope = LIBRARY_INBOX,
  ): Promise<InboxWindow> {
    return await runScenarioInbox(this.#runtime, (inbox) =>
      inbox.window({ scope, filter, first: 200 }),
    );
  }

  async createScheduledTask(input: Parameters<ScenarioSeedPort["createScheduledTask"]>[0]) {
    const automationId = createUuidV7();
    const result = await this.#applyAutomation({
      kind: "create_definition",
      automation_id: automationId,
      definition: toCoreAutomationDefinitionInput(input),
    });
    const definition = result.outcome.definitions.find(
      (item) => item.automation_id === automationId,
    );
    if (!definition) throw new Error(`Scheduled task ${input.name} was not created`);
    return projectAutomationDefinition(definition);
  }

  async holdScheduledTaskNow(automationId: string): Promise<{ readonly pageId: string }> {
    const task = await this.#scheduledTask(automationId);
    if (task.launch !== "ask") throw new Error("Only an Ask task can wait in the Inbox");
    // A zero retry window makes this task due without waiting for its recurrence.
    await this.#applyAutomation({
      kind: "reschedule_definition",
      automation_id: automationId,
      expected_revision: task.definitionRevision,
      not_before_ms: null,
      retry_within_ms: 0,
    });
    const { lease, definition } = await this.#claimScheduledTask(automationId);
    if (lease.purpose !== "hold") throw new Error("Expected a scheduled hold lease");
    await runScenarioInbox(this.#runtime, (inbox) =>
      inbox.holdScheduledFiring({
        leaseId: lease.lease_id,
        dispatchId: lease.dispatch_id,
        purpose: "hold",
        admission: null,
        definitionRevision: lease.definition_revision,
        scheduledFor: lease.scheduled_for_ms,
        attempt: lease.attempt,
        expiresAt: lease.expires_at_ms,
        definition: projectAutomationDefinition(definition),
      }),
    );
    const firing = (await this.#scheduledTask(automationId)).heldFiring;
    if (!firing) throw new Error("Scheduled hold omitted its Inbox message");
    return { pageId: firing.pageId };
  }

  async failScheduledRunNow(automationId: string): Promise<void> {
    const firing = (await this.#scheduledTask(automationId)).heldFiring;
    if (!firing) throw new Error("Scheduled failure needs a waiting firing to confirm");
    await runScenarioInbox(this.#runtime, (inbox) => inbox.confirmScheduledFiring(firing));
    const { lease } = await this.#claimScheduledTask(automationId);
    if (lease.purpose !== "run" || lease.admission?.page_id !== firing.pageId) {
      throw new Error("Expected the confirmed firing's admitted run lease");
    }
    await this.#applyAutomation({
      kind: "fail_lease",
      lease_id: lease.lease_id,
      retry_delay_ms: null,
      reason_code:
        "This scheduled task's Agent is off or unavailable. Turn it on in Settings or choose another Agent.",
    });
  }

  async skipScheduledFiring(pageId: string): Promise<void> {
    await runScenarioInbox(this.#runtime, (inbox) =>
      inbox.setState({ pageIds: [pageId], state: "done" }),
    );
  }

  async readScheduledTasks() {
    return await runScenarioAutomation(
      this.#runtime,
      Effect.fn("CoreClientSeedAdapter.readScheduledTasks")(function* (automation) {
        const items = [];
        let after: string | null = null;
        do {
          const snapshot: AutomationReadSnapshot = yield* automation.read({
            kind: "definitions",
            window: { after, first: 200 },
          });
          if (snapshot.value.kind !== "definitions") {
            throw new Error("Scheduled task inspection returned an unexpected value");
          }
          items.push(...snapshot.value.window.items.map(projectAutomationDefinition));
          after = snapshot.value.window.next_cursor ?? null;
        } while (after !== null);
        return items;
      }),
    );
  }

  async #scheduledTask(automationId: string) {
    const snapshot = await runScenarioAutomation(this.#runtime, (automation) =>
      automation.read({ kind: "definition", automation_id: automationId }),
    );
    if (snapshot.value.kind !== "definition" || !snapshot.value.item) {
      throw new Error(`Scheduled task ${automationId} is missing`);
    }
    return projectAutomationDefinition(snapshot.value.item);
  }

  async #claimScheduledTask(automationId: string) {
    const due = await runScenarioAutomation(this.#runtime, (automation) =>
      automation.read({ kind: "due_work", lane: "definitions" }),
    );
    if (due.value.kind !== "due_work" || !due.value.plan.work_token) {
      throw new Error(`Scheduled task ${automationId} has no due firing`);
    }
    const result = await this.#applyAutomation({
      kind: "claim_due",
      work_token: due.value.plan.work_token,
      limit: 1,
      lease_duration_ms: 60_000,
    });
    const lease = result.outcome.claimed_leases[0];
    const definition = result.outcome.definitions.find(
      (item) => item.automation_id === automationId,
    );
    if (!lease || lease.automation_id !== automationId || !definition) {
      throw new Error(`Claim did not return scheduled task ${automationId}`);
    }
    return { lease, definition };
  }

  #applyAutomation(intent: AutomationIntent) {
    return runScenarioAutomation(this.#runtime, (automation) =>
      automation.apply({ operationId: createUuidV7(), intent }),
    );
  }

  async readPageChatActivity(pageIds: readonly string[]): Promise<PageChatActivitySummaryResult> {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.readPageChatActivitySummaries({
        pageIds: [...pageIds],
      }),
    );
  }

  async readPageChats(pageId: string): Promise<PageChatWindow> {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.listPageChatWindow({
        pageId,
        includeArchived: false,
        first: 50,
      }),
    );
  }

  async createSidebarSection(input: SidebarSectionCreateInput) {
    const { value } = await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.createSidebarSection({
        operationId: createBoundedOperationId("scenario.sidebar-section.create"),
        payload: { sectionId: createUuidV7(), input },
      }),
    );
    return value;
  }

  async createSessionInSidebarSection(input: SidebarSectionSessionCreateInput) {
    const { value } = await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.createSessionInSidebarSection({
        operationId: createBoundedOperationId("scenario.sidebar-section.create-session"),
        payload: { sessionId: createUuidV7(), input },
      }),
    );
    return value;
  }

  async moveSidebarSectionItem(input: SidebarSectionMoveItemInput): Promise<void> {
    await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.moveSidebarSectionItem({
        operationId: createBoundedOperationId("scenario.sidebar-section.move-item"),
        payload: input,
      }),
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

  #library(projectId: string, libraryAuthority = false) {
    const libraryId = this.#libraryIdsByProject.get(projectId);
    if (!libraryId) {
      throw new Error(`Scenario Project ${projectId} was not created by this adapter`);
    }
    return createCoreLibraryModuleAdapter({
      client: libraryAuthority
        ? this.#runtime.rootClient
        : this.#runtime.clientForProject(projectId),
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
            markdown: "Scenario bootstrap authority.",
          },
        });
      }),
    );
  }
}
