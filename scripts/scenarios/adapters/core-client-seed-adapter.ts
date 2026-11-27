import { CoreClient } from "../../../src/main/core-client/core-client";
import { enrollRemoteCore } from "../../../src/main/core-client/remote-http";
import type { DiscussionCommand } from "../../../src/shared/discussions";
import { PAGE_ASK_MESSAGE_PREFIX, pageAskConversationTitle } from "../../../src/shared/page-ask";
import type { ProjectWorkspace } from "../../../src/main/project-application/ProjectWorkspace";
import { seedDecisionRun } from "../seed/decision-run";
import { agentAttributionLabel } from "../../../src/shared/agents/registry";
import { assessSeededAutomationCheck } from "../seed/automation-event";
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
  projectAutomation,
  toCoreAutomationInput,
} from "../../../src/host/automation-application/AutomationProjection";
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
  ScenarioHostedDatabaseSeed,
  ScenarioLibraryFileSeed,
  ScenarioPageObservation,
  ScenarioPageFileEntrySeed,
  ScenarioPageWorkspaceSeed,
  ScenarioPageSeed,
  ScenarioRecoveryDraftSeed,
  ScenarioRelatedChatSeed,
  ScenarioRelatedChatSeedResult,
  ScenarioSeedPort,
  ScenarioDiscussionSeedPort,
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
import { handledMessagesOf, type ScenarioInboxDispatchSeed } from "../contracts";
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

const linkScenarioThread = Effect.fnUntraced(function* (
  workspace: ProjectWorkspace["Service"],
  sessionId: string,
  projectId: string | null,
  thread: NonNullable<ScenarioRelatedChatSeed["thread"]>,
) {
  const observedAt = Date.now();
  yield* workspace.upsertThread(thread.threadId, {
    projectId: projectId,
    threadSource: "user",
    threadName: thread.threadName,
    threadPreview: thread.threadPreview,
    backendBinding: { driver: "codex", instanceId: "codex" },
    status: {
      statusType: thread.statusType,
      activeFlags: [...thread.statusActiveFlags],
    },
    createdAt: observedAt,
    updatedAt: observedAt,
    recencyAt: observedAt,
  });
  yield* workspace.upsertProjectSessionThreadLink({
    sessionId: sessionId,
    projectId: projectId,
    threadId: thread.threadId,
    threadSource: "user",
    threadName: thread.threadName,
    threadPreview: thread.threadPreview,
    backendBinding: { driver: "codex", instanceId: "codex" },
    statusType: thread.statusType,
    statusActiveFlags: [...thread.statusActiveFlags],
    createdAt: observedAt,
    updatedAt: observedAt,
    recencyAt: observedAt,
  });
});

export class CoreClientSeedAdapter implements ScenarioSeedPort {
  readonly discussionSeed: ScenarioDiscussionSeedPort = this;
  readonly #runtime: RustDataAuthorityRuntime;
  readonly #discussionMembers = new Map<string, CoreClient>();
  readonly #libraryIdsByProject = new Map<string, string>();

  constructor(runtime: RustDataAuthorityRuntime) {
    this.#runtime = runtime;
  }

  async enrollDiscussionMembers(ownerName: string, names: readonly string[]) {
    const host = this.#runtime.launch.client;
    const owner = await host.spaceRenameMember({ name: ownerName });
    const listener = await host.listenSpace({ address: "127.0.0.1:0" });
    const ids = [owner.id];
    for (const name of names) {
      const invite = await host.spaceInvite({ role: "member" });
      const member = await enrollRemoteCore(listener, {
        code: invite.code,
        display_name: name,
        device_label: `${name}'s fixture desktop`,
      });
      const client = await CoreClient.connectRemote({
        ...listener,
        buildId: "page-discussions-seed",
        spaceId: member.space_id,
        deviceCredential: member.device_credential,
      });
      this.#discussionMembers.set(member.member_id, client);
      ids.push(member.member_id);
    }
    return ids;
  }

  async #writeDiscussion(command: DiscussionCommand, memberId?: string, agentAttribution?: string) {
    const client = memberId ? this.#discussionMembers.get(memberId) : this.#runtime.rootClient;
    if (!client) throw new Error(`Missing the scenario connection for Member ${memberId}`);
    const committed = await client.libraryApply(
      { operationId: createUuidV7(), intent: { kind: "discussion", command } },
      { agentAttribution },
    );
    const result = committed.outcome.discussion;
    if (!result) throw new Error(`Core omitted the ${command.kind} Discussion receipt`);
    return result;
  }

  async createDiscussion(
    ...[command, memberId]: Parameters<ScenarioDiscussionSeedPort["createDiscussion"]>
  ) {
    await this.#writeDiscussion(command, memberId);
  }

  async replyToDiscussion(discussionId: string, body: string, memberId: string) {
    await this.#writeDiscussion({ kind: "reply", discussionId, comment: { body } }, memberId);
  }

  async seedAgentDiscussionReply(
    input: Parameters<ScenarioDiscussionSeedPort["seedAgentDiscussionReply"]>[0],
  ) {
    const host = this.#runtime.rootClient;
    const sessionId = createUuidV7();
    const messageId = `${PAGE_ASK_MESSAGE_PREFIX}${createUuidV7()}`;
    const reserved = await this.#writeDiscussion({
      kind: "reserve_ask",
      commentId: input.requestId,
      messageId,
      newSessionId: sessionId,
    });
    const request = reserved.kind === "comment" ? reserved.value : null;
    const launchId = request?.ask?.dispatch?.launchId;
    if (!request || !launchId) throw new Error("The scenario Ask did not reserve a new Session");
    await host.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: input.projectId,
        title: pageAskConversationTitle(request.body, "Ask from Page"),
        initial_page_ids: [],
        runtime_id: "scenario:page-discussions",
        runtime_thread_id: createUuidV7(),
        launch_request_id: launchId,
      },
    });
    const runId = createUuidV7();
    const run = {
      session_id: sessionId,
      run_id: runId,
      driver: "codex",
      label: agentAttributionLabel("codex"),
    };
    await host.recordAgentRun({ ...run, message_id: messageId });
    const attribution = await host.issueAgentAttribution(run);
    await this.#writeDiscussion(
      { kind: "reply", discussionId: input.discussionId, comment: input.reply },
      undefined,
      attribution,
    );
    // Core settles to Answered or Needs you by inspecting the attributed reply.
    await this.#writeDiscussion({
      kind: "settle_ask",
      commentId: input.requestId,
      messageId,
      runId,
      state: "failed",
      fallback: "",
    });
  }

  async readDiscussion(projectId: string, discussionId: string) {
    const read = await this.#runtime.clientForProject(projectId).libraryRead({
      kind: "discussion",
      discussion_id: discussionId,
    });
    if (read.value.kind !== "discussion") throw new Error(`Missing Discussion ${discussionId}`);
    return read.value.value;
  }

  async assessAutomationCheck(sequence: number) {
    return assessSeededAutomationCheck(this.#runtime.rootClient, sequence);
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
  async reportPageWork(input: Parameters<ScenarioSeedPort["reportPageWork"]>[0]) {
    const runId = createUuidV7();
    const runStartedAt = Date.now();
    await this.#agentCommand(
      input.sessionId,
      {
        kind: "report_page_work",
        page_id: input.pageId,
        outcome: input.outcome,
        summary: input.summary,
      },
      runId,
    );
    if (input.outcome === "ready")
      await this.recordSessionExecution(input.sessionId, {
        state: "idle",
        runId,
        runStartedAt,
        pendingRequestIds: [],
        pendingRequests: [],
        queue: null,
        terminalStatus: "completed",
        personStopped: false,
        stalled: false,
        progressFingerprint: null,
        progressSince: runStartedAt,
      });
  }

  async handBackChatMessage(input: Parameters<ScenarioSeedPort["handBackChatMessage"]>[0]) {
    const client = this.#runtime.rootClient;
    const sessionId = createUuidV7(),
      runId = createUuidV7();
    const { pageId } = await this.sendInboxMessage(input.body);
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
    const captured = await client.workspaceRead({ kind: "inbox_entry", page_id: pageId });
    if (captured.value.kind !== "inbox_entry" || !captured.value.item)
      throw new Error("Missing handback message");
    const proposalId = createUuidV7();
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "dispatch_inbox_entries",
        proposal_id: proposalId,
        page_ids: [pageId],
        basis: [captured.value.item.basis],
        expected_store_epoch: captured.store_epoch,
        action: inboxDispatchActionToCore({
          type: "send_to_chat",
          sessionId,
          prompt: input.body,
          additions: [],
        }),
      },
    });
    const work = await runScenarioInbox(this.#runtime, (inbox) => inbox.outbox(16));
    const deliveryId = work.find((delivery) => delivery.proposal_id === proposalId)?.message_id;
    if (!deliveryId) throw new Error("Missing handback delivery");
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
        page_id: createUuidV7(),
        document_id: createUuidV7(),
      },
      runId,
    );
    return { pageId, sessionId };
  }

  async createWorkChat(input: Parameters<ScenarioSeedPort["createWorkChat"]>[0]) {
    const client = this.#runtime.rootClient;
    const sessionId = createUuidV7();
    const launchId = createUuidV7();
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "start_page_work",
        launch_id: launchId,
        message_id: createUuidV7(),
        session_id: sessionId,
        page_id: input.pageId,
        brief: input.title,
        again: false,
        selection: input.selection,
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "settle_page_work_launch",
        launch_id: launchId,
        accepted_at: new Date().toISOString(),
      },
    });
    const thread = input.thread;
    if (thread) {
      await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
        linkScenarioThread(workspace, sessionId, input.projectId, thread),
      );
      return { sessionId, threadId: thread.threadId };
    }
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: input.projectId,
        title: input.title,
        initial_page_ids: [input.pageId],
        runtime_id: "scenario:work",
        runtime_thread_id: createUuidV7(),
        launch_request_id: launchId,
      },
    });
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

  async recordSourceProblem() {
    const client = this.#runtime.rootClient;
    const sourceId = "github:scenario";
    const config = {
      host: "github.com",
      account_id: "1",
      account_login: "scenario",
      credential_ref: "gh:github.com:scenario",
      repositories: [],
      discovery: { assigned: false, mentions: false, review_requests: false },
    };
    const apply = (
      command: import("@nodex/core-protocol").components["schemas"]["SourceCommand"],
    ) =>
      client.workspaceApply({ operationId: createUuidV7(), intent: { kind: "source", command } });
    await apply({
      kind: "configure_source",
      source_id: sourceId,
      expected_revision: 0,
      enabled: true,
      config,
    });
    for (let n = 0; n < 3; n++)
      await apply({
        kind: "record_source_failure",
        source_id: sourceId,
        config_revision: 1,
        partition: null,
        lease_token: null,
        problem_kind: "poll_failed",
        evidence: { reason: "GitHub could not be reached" },
        retry_at_ms: 0,
      });
    await apply({
      kind: "configure_source",
      source_id: sourceId,
      expected_revision: 1,
      enabled: false,
      config,
    });
    const result = await client.workspaceRead({
      kind: "sources",
      read: { kind: "open_problems", source_id: sourceId, after_id: null, limit: 1 },
    });
    if (
      result.value.kind !== "sources" ||
      result.value.value.kind !== "open_problems" ||
      !result.value.value.problems[0]
    )
      throw new Error("Expected Source problem");
    return result.value.value.problems[0].id;
  }
  async readActivity() {
    return (
      await runScenarioInbox(this.#runtime, (inbox) =>
        inbox.activity({ scope: { kind: "all" }, filter: "all", first: 100 }),
      )
    ).rows;
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
    const request = await this.#beginRouting(
      [input.questionPageId],
      "Nodex · Routing an Inbox question",
    );
    await this.#agentCommand(request.sessionId, {
      kind: "answer_inbox_question",
      request_id: request.requestId,
      generation: request.generation,
      question_page_id: input.questionPageId,
      page_id: pageId,
      document_id: createUuidV7(),
      body: input.body,
    });
    return { pageId };
  }

  async #beginRouting(pageIds: readonly string[], title: string) {
    const client = this.#runtime.rootClient;
    return runScenarioInbox(this.#runtime, function (inbox) {
      return Effect.gen(function* () {
        const context = yield* inbox.dispatchContext(pageIds);
        const requestId = createUuidV7();
        yield* inbox.requestSuggestion({
          requestId,
          pageIds,
          mode: "auto",
          basis: context.entries.map((entry) => inboxPageBasisFromCore(entry.basis)),
        });
        const request = yield* inbox.suggestionRequest(requestId);
        if (!request) throw new Error("Scenario routing request was not admitted");
        const generation = request.generation;
        const sessionId = yield* Effect.promise(() =>
          seedDecisionRun(client, { kind: "routing", request_id: requestId, generation }, title),
        );
        yield* inbox.beginRouting(request, sessionId);
        return { requestId, generation, sessionId };
      });
    });
  }

  async settleRoutingSuggestion(input: Parameters<ScenarioSeedPort["settleRoutingSuggestion"]>[0]) {
    const request = await this.#beginRouting(input.pageIds, `Nodex · Routing ${input.summary}`);
    return runScenarioInbox(
      this.#runtime,
      Effect.fn("Scenario.settleRoutingSuggestion")(function* (inbox) {
        const proposalId = createUuidV7();
        yield* inbox.settleSuggestion({
          request_id: request.requestId,
          generation: request.generation,
          decision_session_id: request.sessionId,
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

  async setInboxRoutingConsent(startMyRequests: boolean) {
    await this.#runtime.rootClient.workspaceApply({
      operationId: createBoundedOperationId("scenario.inbox-consent"),
      intent: {
        kind: "set_inbox_routing_consent",
        start_my_requests: startMyRequests,
        initialize_only: false,
      },
    });
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

  async createHostedDatabase({
    projectId,
    parentPageId,
    operationId,
    ...database
  }: ScenarioHostedDatabaseSeed): Promise<void> {
    const parent = requireSuccess(
      await createCoreDocumentSyncAdapter(this.#runtime.clientForProject(projectId)).prepareOwner({
        ownerBlockId: parentPageId,
        operationId: createUuidV7(),
        clientSessionId: "scenario:hosted-database",
      }),
      "Prepare Database host Page",
    );
    requireSuccess(
      await this.#library(projectId).apply({
        operationId,
        storeEpoch: parent.storeEpoch,
        operation: {
          kind: "create_database",
          ...database,
          parent: {
            kind: "page",
            pageId: parentPageId,
            expectedDocumentGeneration: parent.generation,
            expectedDocumentHeadSeq: parent.headSeq,
          },
        },
      }),
      `Create ${database.name}`,
    );
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
          driver: input.attachedByAgent.driver,
          label: agentAttributionLabel(input.attachedByAgent.driver),
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
      parent: detail.page.parent,
      parentRevision: detail.page.parentRevision,
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
        yield* linkScenarioThread(workspace, session.id, input.projectId, input.thread);
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

  async setSessionSnooze(sessionId: string, snoozedUntil: string | null): Promise<void> {
    await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.setProjectSessionSnooze({
        operationId: createBoundedOperationId("scenario.session.snooze"),
        payload: { sessionId, snoozedUntil },
      }),
    );
  }

  async settleSessions(sessionIds: readonly string[]): Promise<void> {
    await runScenarioProjectWorkspace(this.#runtime, (workspace) =>
      workspace.setProjectSessionSettled({
        operationId: createBoundedOperationId("scenario.session.settle"),
        payload: { sessionIds: [...sessionIds], settled: true },
      }),
    );
  }

  async deliverDueSessionSnooze(sessionId: string): Promise<void> {
    await runScenarioProjectWorkspace(
      this.#runtime,
      Effect.fn("Scenario.deliverDueSessionSnooze")(function* (workspace) {
        const due = yield* workspace.nextSessionSnooze;
        if (
          due?.session.id !== sessionId ||
          due.deliveryId ||
          Date.parse(due.wakeAt) > Date.now()
        ) {
          throw new Error("Expected the seeded chat to be the next due snooze");
        }
        const claimed = yield* workspace.consumeSessionSnooze(
          sessionId,
          due.memberId,
          due.snoozedUntil,
          true,
        );
        const delivery = yield* workspace.nextSessionSnooze;
        if (!claimed || delivery?.session.id !== sessionId || !delivery.deliveryId) {
          throw new Error("The seeded chat has no claimed snooze delivery");
        }
        const completed = yield* workspace.completeSessionSnooze(
          sessionId,
          delivery.deliveryId,
          true,
        );
        if (!completed) throw new Error("The seeded chat's snooze delivery did not complete");
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

  async setInboxSnooze(pageIds: readonly string[], until: string): Promise<void> {
    await runScenarioInbox(this.#runtime, (inbox) => inbox.setSnooze({ pageIds, until }));
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

  async readInboxNotesPage(scope: InboxScope) {
    return await runScenarioInbox(this.#runtime, (inbox) =>
      inbox.summary({ scope }).pipe(Effect.map((summary) => summary.notesPageId)),
    );
  }

  async readInbox(
    scope: InboxScope = LIBRARY_INBOX,
    filter: "inbox" | "snoozed" = "inbox",
  ): Promise<InboxWindow> {
    return await runScenarioInbox(this.#runtime, (inbox) =>
      inbox.window({ scope, filter, first: 200 }),
    );
  }

  async readHandledMessages(scope: InboxScope = LIBRARY_INBOX) {
    return handledMessagesOf(
      (
        await runScenarioInbox(this.#runtime, (inbox) =>
          inbox.activity({ scope, filter: "messages", first: 100 }),
        )
      ).rows,
    );
  }

  async createAutomation(input: Parameters<ScenarioSeedPort["createAutomation"]>[0]) {
    const automationId = createUuidV7();
    const result = await this.#applyAutomation({
      kind: "create_automation",
      automation_id: automationId,
      automation: toCoreAutomationInput(input),
    });
    const definition = result.outcome.automations.find(
      (item) => item.automation_id === automationId,
    );
    if (!definition) throw new Error(`Automation ${input.name} was not created`);
    return projectAutomation(definition);
  }

  async holdAutomationNow(automationId: string): Promise<{ readonly pageId: string }> {
    const task = await this.#automation(automationId);
    if (task.mode !== "ask_first")
      throw new Error("Only an Ask first Automation can wait in the Inbox");
    // A zero retry window makes this task due without waiting for its recurrence.
    await this.#applyAutomation({
      kind: "reschedule_automation",
      automation_id: automationId,
      expected_revision: task.automationRevision,
      not_before_ms: null,
      retry_within_ms: 0,
    });
    const { lease, definition } = await this.#claimAutomation(automationId);
    if (lease.purpose !== "hold") throw new Error("Expected an Automation hold lease");
    await runScenarioInbox(this.#runtime, (inbox) =>
      inbox.holdAutomationDecision({
        leaseId: lease.lease_id,
        dispatchId: lease.dispatch_id,
        purpose: "hold",
        admission: null,
        automationRevision: lease.automation_revision,
        scheduledFor: lease.scheduled_for_ms,
        attempt: lease.attempt,
        expiresAt: lease.expires_at_ms,
        definition: projectAutomation(definition),
      }),
    );
    const firing = (await this.#automation(automationId)).heldDecision;
    if (!firing) throw new Error("Automation hold omitted its Inbox message");
    return { pageId: firing.pageId };
  }

  async failAutomationRunNow(automationId: string): Promise<void> {
    const firing = (await this.#automation(automationId)).heldDecision;
    if (!firing) throw new Error("Automation failure needs a waiting decision to confirm");
    await runScenarioInbox(this.#runtime, (inbox) => inbox.confirmAutomationDecision(firing));
    const { lease } = await this.#claimAutomation(automationId);
    if (lease.purpose !== "run" || lease.admission?.page_id !== firing.pageId) {
      throw new Error("Expected the confirmed firing's admitted run lease");
    }
    await this.#applyAutomation({
      kind: "fail_lease",
      lease_id: lease.lease_id,
      retry_delay_ms: null,
      reason_code:
        "This Automation's Agent is off or unavailable. Turn it on in Settings or choose another Agent.",
    });
  }

  async skipAutomationDecision(pageId: string): Promise<void> {
    await runScenarioInbox(this.#runtime, (inbox) => inbox.markDone({ pageIds: [pageId] }));
  }

  async readAutomations() {
    return await runScenarioAutomation(
      this.#runtime,
      Effect.fn("CoreClientSeedAdapter.readAutomations")(function* (automation) {
        const items = [];
        let after: string | null = null;
        do {
          const snapshot: AutomationReadSnapshot = yield* automation.read({
            kind: "automations",
            window: { after, first: 200 },
          });
          if (snapshot.value.kind !== "automations") {
            throw new Error("Automation inspection returned an unexpected value");
          }
          items.push(...snapshot.value.window.items.map(projectAutomation));
          after = snapshot.value.window.next_cursor ?? null;
        } while (after !== null);
        return items;
      }),
    );
  }

  async #automation(automationId: string) {
    const snapshot = await runScenarioAutomation(this.#runtime, (automation) =>
      automation.read({ kind: "automation", automation_id: automationId }),
    );
    if (snapshot.value.kind !== "automation" || !snapshot.value.item) {
      throw new Error(`Automation ${automationId} is missing`);
    }
    return projectAutomation(snapshot.value.item);
  }

  async #claimAutomation(automationId: string) {
    const due = await runScenarioAutomation(this.#runtime, (automation) =>
      automation.read({ kind: "due_work", lane: "automations" }),
    );
    if (due.value.kind !== "due_work" || !due.value.plan.work_token) {
      throw new Error(`Automation ${automationId} has no due firing`);
    }
    const result = await this.#applyAutomation({
      kind: "claim_due",
      work_token: due.value.plan.work_token,
      limit: 1,
      lease_duration_ms: 60_000,
    });
    const lease = result.outcome.claimed_leases[0];
    const definition = result.outcome.automations.find(
      (item) => item.automation_id === automationId,
    );
    if (!lease || lease.automation_id !== automationId || !definition) {
      throw new Error(`Claim did not return Automation ${automationId}`);
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
