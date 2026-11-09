import { createHash } from "node:crypto";
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
  ScenarioPageWorkspaceSeed,
  ScenarioPageSeed,
  ScenarioRecoveryDraftSeed,
  ScenarioRelatedChatSeed,
  ScenarioRelatedChatSeedResult,
  ScenarioSeedPort,
  ScenarioStandalonePageSeed,
} from "../contracts";
import { buildRecoveryDraftCapture } from "../seed/recovery-draft";
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
  DEFAULT_INBOX_SETTINGS,
  type InboxScope,
  type InboxWindow,
} from "../../../src/shared/inbox";
import { parsePageWork } from "../../../src/shared/work-graph";
import type { ProjectWorkspaceApplyInput } from "../../../src/main/core-client/types";
import { inboxDispatchActionToCore } from "../../../src/main/core-client/inbox-adapter";
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

/** Whether a Profile already holds a Project or a Session. */
export const profileHasWork = async (runtime: RustDataAuthorityRuntime): Promise<boolean> =>
  (await runScenarioProjectWorkspace(runtime, (workspace) => workspace.readProjectBootstrap))
    .status === "ready";

export class CoreClientSeedAdapter implements ScenarioSeedPort {
  readonly #runtime: RustDataAuthorityRuntime;
  readonly #libraryIdsByProject = new Map<string, string>();

  constructor(runtime: RustDataAuthorityRuntime) {
    this.#runtime = runtime;
  }

  async createCoordinatorSession(): Promise<string> {
    const sessionId = createUuidV7();
    await this.#runtime.rootClient.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_agent_runtime_session",
        coordinator: true,
        session_id: sessionId,
        project_id: null,
        title: "Nodex",
        initial_page_ids: [],
        runtime_id: "scenario:coordinator",
        runtime_thread_id: createUuidV7(),
        launch_request_id: createUuidV7(),
      },
    });
    return sessionId;
  }

  async setPageWork(...[projectId, pageId, work]: Parameters<ScenarioSeedPort["setPageWork"]>) {
    const detail = await this.readPage(projectId, pageId);
    if (!detail.pageWork) throw new Error("Seed Page has no work authority");
    requireSuccess(
      await this.#library(projectId).applyBlockPropertyMutation({
        mutationId: createUuidV7(),
        projectId,
        storeEpoch: this.#runtime.identity.storeEpoch,
        actor: { kind: "scenario_seed" },
        fields: [
          {
            scope: "intrinsic",
            blockId: pageId,
            propertyKey: "work",
            operation: "set",
            expectedRevision: 1,
            value: { ...work, owner: detail.pageWork.owner },
          },
        ],
      }),
      "Set Page Agent work",
    );
  }

  async recordSessionExecution(
    sessionId: string,
    observation: import("@nodex/core-protocol").components["schemas"]["SessionExecutionObservation"],
  ): Promise<void> {
    const snapshot = await this.#runtime.rootClient.workspaceRead({
      kind: "session_execution_observer",
      session_id: sessionId,
    });
    if (snapshot.value.kind !== "session_execution_observer")
      throw new Error("Missing execution observer");
    await this.#runtime.rootClient.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "record_session_execution",
        session_id: sessionId,
        expected_revision: snapshot.value.observer?.revision ?? 0,
        observation,
        events: [],
        resolved_request_ids: [],
      },
    });
  }
  async readPageTurn(pageId: string) {
    const snapshot = await this.#runtime.rootClient.workspaceRead({
      kind: "page_turn",
      page_id: pageId,
    });
    if (snapshot.value.kind !== "page_turn") throw new Error("Missing Page Turn");
    return snapshot.value.turn;
  }
  async setSessionManaged(sessionId: string, managed: boolean) {
    await this.#runtime.rootClient.workspaceApply({
      operationId: createUuidV7(),
      intent: { kind: "set_session_managed", session_id: sessionId, managed },
    });
  }

  async reportPageWork(input: Parameters<ScenarioSeedPort["reportPageWork"]>[0]) {
    await this.setSessionManaged(input.sessionId, true);
    await this.#agentCommand(input.sessionId, {
      kind: "report_page_work",
      page_id: input.pageId,
      outcome: input.outcome,
      summary: input.summary,
    });
  }

  async handBackChatMessage(input: Parameters<ScenarioSeedPort["handBackChatMessage"]>[0]) {
    const client = this.#runtime.rootClient;
    const sessionId = createUuidV7(),
      deliveryId = createUuidV7(),
      runId = createUuidV7(),
      pageId = createUuidV7();
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: null,
        title: "Documentation",
        initial_page_ids: [],
        runtime_id: "scenario:handback",
        runtime_thread_id: createUuidV7(),
        launch_request_id: createUuidV7(),
      },
    });
    await this.setSessionManaged(sessionId, true);
    const bodyHash = createHash("sha256").update(input.body).digest("hex");
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "record_chat_delivery",
        session_id: sessionId,
        delivery_id: deliveryId,
        body_hash: bodyHash,
        author: { kind: "user" },
        attachment_count: 0,
        question_answer_run_id: null,
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "bind_chat_inbound",
        session_id: sessionId,
        run_id: runId,
        delivery_id: deliveryId,
        body_hash: bodyHash,
        attachment_count: 0,
        author: { kind: "user" },
      },
    });
    await this.#agentCommand(
      sessionId,
      {
        kind: "hand_back_message",
        reason: input.reason,
        page_id: pageId,
        document_id: createUuidV7(),
        message: { text: input.body, files: [] },
      },
      runId,
    );
    return { pageId, sessionId };
  }

  async createWorkChat(input: Parameters<ScenarioSeedPort["createWorkChat"]>[0]) {
    const sessionId = createUuidV7();
    await this.#runtime.rootClient.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: input.projectId,
        title: input.title,
        initial_page_ids: [input.pageId],
        runtime_id: "scenario:work",
        runtime_thread_id: createUuidV7(),
        launch_request_id: createUuidV7(),
      },
    });
    // An Agent chat has no native thread of its own.
    return { sessionId, threadId: null };
  }

  async pauseWork(scope: Parameters<ScenarioSeedPort["pauseWork"]>[0]) {
    await this.#runtime.rootClient.workspaceApply({
      operationId: createUuidV7(),
      intent: { kind: "pause_work", scope },
    });
  }

  async recordPageWorkspace(input: ScenarioPageWorkspaceSeed) {
    const client = this.#runtime.rootClient;
    const workspaceId = createUuidV7();
    const allocation = createUuidV7();
    // A GitHub-hosted repository identity, so the pull request below can belong to the branch.
    const repository = "https://github.com/nodex-scenario/workspace";
    const worktreePath = `${input.repositoryRoot}/.worktrees/${input.branchName}`;
    await client.workspaceApply({
      operationId: allocation,
      intent: {
        kind: "claim_page_workspace",
        workspace_id: workspaceId,
        page_id: input.pageId,
        project_id: input.projectId,
        session_id: input.sessionId,
        repository_url: repository,
        repository_root: input.repositoryRoot,
        branch_name: input.branchName,
        base_commit_oid: "0".repeat(40),
        worktree_path: worktreePath,
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "record_page_workspace_ready",
        workspace_id: workspaceId,
        allocation_operation_id: allocation,
        branch_name: input.branchName,
        worktree_path: worktreePath,
      },
    });
    if (!input.pullRequest) return;
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "upsert_page_pull_request",
        workspace_id: workspaceId,
        head_branch: input.branchName,
        repository,
        number: input.pullRequest.number,
        url: `${repository}/pull/${input.pullRequest.number}`,
        state: input.pullRequest.state,
        observed_at: new Date().toISOString(),
      },
    });
  }

  async writeTurnNote(input: Parameters<ScenarioSeedPort["writeTurnNote"]>[0]) {
    const client = this.#runtime.rootClient;
    const dedupe = createUuidV7();
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "record_work_events",
        observed: [],
        events: [
          {
            kind: "attention",
            session_id: input.sessionId ?? null,
            page_id: input.pageId,
            payload: {},
            dedupe_key: dedupe,
          },
        ],
      },
    });
    const pending = await client.workspaceRead({ kind: "read_pending_work_events", limit: 100 });
    if (pending.value.kind !== "read_pending_work_events") throw new Error("Expected Work updates");
    const event = pending.value.events.find((e) => e.dedupe_key === dedupe);
    if (!event) throw new Error("Missing note event");
    const batch = createUuidV7();
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_event_batch",
        batch_id: batch,
        coordinator_session_id: input.coordinatorSessionId,
        event_ids: [event.event_id],
        message_id: createUuidV7(),
        body: "Scenario Work updates",
        fingerprint: "a".repeat(64),
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "settle_event_batch",
        batch_id: batch,
        accepted_at: new Date().toISOString(),
      },
    });
    await this.#agentCommand(input.coordinatorSessionId, {
      kind: "write_turn_note",
      note_id: createUuidV7(),
      page_id: input.pageId,
      event_ids: [event.event_id],
      body: input.body,
      notify: input.notify,
    });
  }
  async answerInboxQuestion(input: Parameters<ScenarioSeedPort["answerInboxQuestion"]>[0]) {
    const pageId = createUuidV7();
    await this.#runtime.rootClient.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "set_inbox_entry_kind",
        page_id: input.questionPageId,
        entry_kind: "question",
      },
    });
    await this.#agentCommand(input.coordinatorSessionId, {
      kind: "answer_inbox_question",
      question_page_id: input.questionPageId,
      page_id: pageId,
      document_id: createUuidV7(),
      body: input.body,
    });
    return { pageId };
  }

  async settleCoordinatorSuggestion(
    input: Parameters<ScenarioSeedPort["settleCoordinatorSuggestion"]>[0],
  ) {
    return await runScenarioInbox(
      this.#runtime,
      Effect.fn("Scenario.settleCoordinatorSuggestion")(function* (inbox) {
        const context = yield* inbox.dispatchContext(input.pageIds);
        yield* inbox.requestSuggestion({
          requestId: createUuidV7(),
          pageIds: input.pageIds,
          mode: "auto",
          basis: context.entries.map((entry) => inboxPageBasisFromCore(entry.basis)),
        });
        const request = (yield* inbox.suggestionRequests(100)).find((request) =>
          input.pageIds.every((id) => request.page_ids.includes(id)),
        );
        if (!request) throw new Error("Scenario routing request was not admitted");
        yield* inbox.beginRouting(request, input.coordinatorSessionId);
        const proposalId = createUuidV7();
        yield* inbox.settleSuggestion({
          request_id: request.request_id,
          generation: request.generation,
          titles: [],
          produced_by: "Nodex",
          error: null,
          automatic_dispatch: input.automaticDispatch ?? false,
          suggestions: [
            {
              proposal_id: proposalId,
              page_ids: input.pageIds,
              action: inboxDispatchActionToCore(input.action),
              entry_kind: input.kind,
              summary: input.summary,
              rationale: input.rationale,
              explicit_request: input.explicitRequest ?? false,
            },
          ],
        });
        return proposalId;
      }),
    );
  }

  async confirmInboxRequestByNodex(
    proposalId: string,
    selection: Parameters<ScenarioSeedPort["confirmInboxRequestByNodex"]>[1],
  ) {
    await runScenarioInbox(
      this.#runtime,
      Effect.fn("Scenario.confirmInboxRequestByNodex")(function* (inbox) {
        const window = yield* inbox.window({ scope: LIBRARY_INBOX, filter: "inbox", first: 200 });
        const proposal = window.items
          .flatMap((item) => (item.proposal ? [item.proposal] : []))
          .find((proposal) => proposal.proposalId === proposalId);
        if (!proposal) throw new Error("Scenario automatic proposal is missing");
        const prepared = yield* inbox.prepareConfirmation({
          kind: "proposal",
          storeEpoch: window.storeEpoch,
          proposalId,
          expectedRevision: proposal.revision,
          basis: proposal.basis,
          action: proposal.action,
        });
        if (prepared.kind !== "proposal") throw new Error("Expected a proposal confirmation");
        const { kind: _kind, ...confirmation } = prepared;
        yield* inbox.confirm(confirmation, "nodex");
      }),
      { ...DEFAULT_INBOX_SETTINGS, dispatchMode: "act_on_requests" },
      [
        {
          instanceId: selection.instanceId,
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          version: "scenario",
          auth: { status: "authenticated" },
          checkedAt: new Date().toISOString(),
          models: [
            {
              slug: selection.model,
              name: selection.model,
              isDefault: true,
              isCustom: false,
              capabilities: {},
            },
          ],
          skills: [],
          slashCommands: [],
        },
      ],
    );
  }

  /** The Host supplies only the execution identity an actual Agent would have produced. */
  async #agentCommand(
    sessionId: string,
    intent: ProjectWorkspaceApplyInput["intent"],
    turnId = createUuidV7(),
  ) {
    const session = await this.readSession(sessionId);
    const threadId = session?.executionRef?.threadId ?? session?.thread?.threadId;
    if (!session || !threadId) throw new Error("Scenario Agent requires an execution identity");
    if (!session.executionRef)
      await this.#runtime.rootClient.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "admit_turn_authority",
          thread_id: threadId,
          root_thread_id: threadId,
          turn_id: turnId,
          actor_project_id: session.projectId,
        },
      });
    await this.#runtime.rootClient.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "agent_command",
        intent,
        provenance: {
          profile_id: this.#runtime.identity.profileId,
          authority: {
            thread_id: threadId,
            root_thread_id: threadId,
            turn_id: turnId,
            actor_project_id: session.projectId,
            library_id: this.#runtime.rootClient.handshake.library_id,
            store_epoch: this.#runtime.identity.storeEpoch,
            ...(session.executionRef
              ? {
                  runtime: {
                    session_id: sessionId,
                    runtime_id: session.executionRef.runtimeId,
                    turn_kind: "run" as const,
                  },
                }
              : {}),
          },
        },
      },
    });
  }

  async createProject(input: ProjectCreateInput): Promise<Project> {
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

  async captureRecoveryDraft(input: ScenarioRecoveryDraftSeed): Promise<void> {
    const client = this.#runtime.clientForProject(input.projectId);
    const clientSessionId = createUuidV7();
    const stream = await client.openDocumentEventStream(
      { documentId: input.documentId, clientSessionId },
      () => undefined,
      () => undefined,
      () => undefined,
    );
    try {
      const canonical = requireSuccess(
        await createCoreDocumentSyncAdapter(client).sync({
          documentId: input.documentId,
          clientSessionId,
          stateVector: new Uint8Array([0]),
        }),
        `Read ${input.documentId}`,
      );
      await client.documentApply({
        operationId: createBoundedOperationId("document.recovery.capture"),
        clientSessionId,
        intent: {
          kind: "capture_recovery",
          capture: buildRecoveryDraftCapture(input, canonical),
        },
      });
    } finally {
      await stream.close();
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
    const agentAttribution = input.attachedByAgent
      ? await this.#runtime.rootClient.issueAgentAttribution({
          session_id: input.attachedByAgent.sessionId,
          backend: input.attachedByAgent.backend,
        })
      : undefined;
    const result = requireSuccess(
      await this.#library(input.projectId, false, agentAttribution).apply({
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
      pageWork: parsePageWork(
        detail.intrinsicProperties.find((item) => item.key === "work")?.value ?? null,
      ),
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
              initialPageIds: [],
            },
          },
        });
        for (const pageId of input.relatedPageIds) {
          if (input.handOff) yield* workspace.handOffPageToProjectSession(session.id, { pageId });
          else yield* workspace.linkPageToProjectSession(session.id, { pageId });
        }
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

  async readSession(sessionId: string) {
    return await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.getProjectSession(sessionId),
    );
  }

  async setSessionReminder(sessionId: string, remindAt: string | null): Promise<void> {
    await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.setProjectSessionReminder({
        operationId: createBoundedOperationId("scenario.session.reminder"),
        payload: { sessionId, remindAt },
      }),
    );
  }

  async setSessionUnread(sessionId: string, unread: boolean): Promise<void> {
    await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.markProjectSessionUnread({
        operationId: createBoundedOperationId("scenario.session.mark-unread"),
        payload: { sessionId, unread },
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

  #library(projectId: string, libraryAuthority = false, agentAttribution?: string) {
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
      ...(agentAttribution ? { agentAttribution } : {}),
    });
  }

  #databasePort(): ScenarioDatabasePort {
    return {
      read: (request) => runScenarioDatabase(this.#runtime, (database) => database.read(request)),
      apply: (request) => runScenarioDatabase(this.#runtime, (database) => database.apply(request)),
    };
  }
}
