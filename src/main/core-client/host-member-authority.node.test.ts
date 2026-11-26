/* @effect-diagnostics asyncFunction:off preferSchemaOverJson:off nodeBuiltinImport:off -- Real HTTPS delegation and read-only LocalCommit evidence are the boundary under test. */
import * as Effect from "effect/Effect";
import * as RemoteSpaceAuthority from "../space-connections/RemoteSpaceAuthority";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import type { components } from "@nodex/core-protocol";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import { parsePageWork } from "../../shared/work-graph";
import { CoreClient } from "./core-client";
import { CoreHttpError, LocalHttpTransport } from "./local-http";
import { enrollRemoteCore } from "./remote-http";
import { readCoreRuntimeConnection } from "./runtime-descriptor";

type HostCall = components["schemas"]["HostCall"];
type InvocationOptions = { hostInvocation: string };
const operation = () => createBoundedOperationId("host.member-authority");

test("HTTPS host calls retain each Member's Actor, attention and right to answer", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const connectionId = createUuidV7();
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "host-member-authority",
      connectionId,
    });
    const connection = readCoreRuntimeConnection(scenario.profile.nodexHome);
    const admin = new LocalHttpTransport(connection.descriptor.endpoint, connection.authCapability);
    const headers = {
      "x-nodex-connection-id": connectionId,
      "x-nodex-connection-binding": host.handshake.connection_binding,
    };
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const enroll = async (name: string) => {
      const invite = await admin.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "member" },
        headers,
      );
      const identity = await enrollRemoteCore(listener, {
        code: invite.code,
        display_name: name,
        device_label: `${name}'s desktop`,
      });
      const client = await CoreClient.connectRemote({
        ...listener,
        deviceCredential: identity.device_credential,
        spaceId: identity.space_id,
        buildId: "host-member-authority",
      });
      return { client, identity };
    };
    const alice = await enroll("Alice");
    const bob = await enroll("Bob");
    expect(alice.identity.member_id).not.toBe(bob.identity.member_id);
    const lease = await host.registerHost({ instance: createUuidV7() });
    const relay = async <A>(
      client: CoreClient,
      call: HostCall,
      use: (options: InvocationOptions) => Promise<A>,
    ) => {
      const result = client.hostCall(call);
      // Attach rejection while Core may refuse an invocation or revoke its Member.
      const outcome = result.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const invocation = await host.pollHost(lease);
      if (!invocation) throw new Error("Missing admitted Host invocation");
      try {
        const value = await use({ hostInvocation: invocation.credential });
        await host.completeHost({
          ...lease,
          id: invocation.id,
          result: { status: "ok", value: null },
        });
        expect(await outcome).toEqual({ value: { status: "ok", value: null } });
        return value;
      } catch (error) {
        await host.completeHost({
          ...lease,
          id: invocation.id,
          result: { status: "error", message: "Test invocation failed" },
        });
        await outcome;
        throw error;
      }
    };
    const pageId = createUuidV7();
    await host.workspaceApply({
      operationId: operation(),
      intent: {
        kind: "create_page_for",
        for: { kind: "project", project_id: scenario.manifest.projectId },
        page_id: pageId,
        document_id: createUuidV7(),
        title: "Bob's request, Alice's Page",
      },
    });
    const detail = await alice.client.libraryRead({ kind: "page_detail", page_id: pageId });
    if (detail.value.kind !== "page_detail") throw new Error("Missing Page");
    const work = detail.value.value.intrinsic_properties.find(
      (property) => property.key === "work",
    )!;
    const assignmentOperation = operation();
    const forgedActor = { actor: { type: "member", member_id: bob.identity.member_id } };
    await alice.client.libraryApply({
      operationId: assignmentOperation,
      intent: {
        kind: "apply_block_property_mutation",
        mutation: {
          ...forgedActor,
          client_session_id: null,
          fields: [
            {
              kind: "intrinsic_set",
              block_id: pageId,
              property_key: "work",
              expected_revision: work.revision,
              value: { ...parsePageWork(work.value)!, owner: alice.identity.member_id },
            },
          ],
        },
      },
    });
    const sessionId = createUuidV7();
    const runId = createUuidV7();
    const startOperation = operation();
    const workMessageId = createUuidV7();
    await relay(bob.client, { operation: "work_start", input: { pageId } }, (options) =>
      host.workspaceApply(
        {
          operationId: startOperation,
          intent: {
            kind: "start_page_work",
            page_id: pageId,
            selection: { instanceId: "codex", model: "model", effort: null },
            session_id: sessionId,
            launch_id: createUuidV7(),
            message_id: workMessageId,
            brief: "Work",
            again: false,
            expected_readiness_epoch: null,
            expected_turn_episode: null,
          },
        },
        options,
      ),
    );
    // The producer attaches execution to the Member's existing Work Session;
    // that bookkeeping must not manufacture a new request by the host Owner.
    const bindingOperation = operation();
    await host.workspaceApply({
      operationId: bindingOperation,
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: scenario.manifest.projectId,
        title: "Bound Work",
        initial_page_ids: [pageId],
        runtime_id: "runtime:host-members",
        runtime_thread_id: "thread:host-members",
        launch_request_id: "launch:host-members",
      },
    });
    // Preparation captures the opening Member before the first observation or CLI call.
    await host.recordAgentRun({
      session_id: sessionId,
      run_id: runId,
      message_id: workMessageId,
      driver: "codex",
      label: "Codex",
    });
    const attribution = await host.issueAgentAttribution({
      session_id: sessionId,
      run_id: runId,
      driver: "codex",
      label: "Codex",
    });
    const laterMessage = createUuidV7();
    await relay(
      alice.client,
      {
        operation: "session_message",
        input: {
          sessionId,
          message: { messageId: laterMessage, text: "A later message from Alice" },
        },
      },
      (options) =>
        host.workspaceApply(
          {
            operationId: operation(),
            intent: {
              kind: "mutate_session",
              session_id: sessionId,
              intent: { kind: "record_user_message", message_id: laterMessage },
            },
          },
          options,
        ),
    );
    const agentOperation = operation();
    await host.libraryApply(
      {
        operationId: agentOperation,
        intent: {
          kind: "create_page",
          page_id: createUuidV7(),
          document_id: createUuidV7(),
          title: "Agent result",
          parent: { kind: "library", before: null },
        },
      },
      { agentAttribution: attribution },
    );
    const observe = async (revision: number, kind: "question" | "approval") => {
      const id = operation();
      await host.workspaceApply({
        operationId: id,
        intent: {
          kind: "record_session_execution",
          session_id: sessionId,
          expected_revision: revision,
          observation: {
            state: "waiting",
            runId,
            runStartedAt: 0,
            pendingRequestIds: [kind],
            pendingRequests: [{ id: kind, kind, question: "Continue?", options: ["Yes", "No"] }],
            queue: null,
            terminalStatus: null,
            personStopped: false,
            stalled: false,
            progressFingerprint: kind,
            progressSince: 0,
          },
        },
      });
      return id;
    };
    const queuedRun = createUuidV7();
    await host.recordAgentRun({
      session_id: sessionId,
      run_id: queuedRun,
      driver: "codex",
      label: "Codex",
    });
    await host.recordAgentRun({
      session_id: sessionId,
      run_id: queuedRun,
      message_id: workMessageId,
      driver: "codex",
      label: "Codex",
    });
    const queuedAttribution = await host.issueAgentAttribution({
      session_id: sessionId,
      run_id: queuedRun,
      driver: "codex",
      label: "Codex",
    });
    const queuedOperation = operation();
    await host.libraryApply(
      {
        operationId: queuedOperation,
        intent: {
          kind: "create_page",
          page_id: createUuidV7(),
          document_id: createUuidV7(),
          title: "Queued result",
          parent: { kind: "library", before: null },
        },
      },
      { agentAttribution: queuedAttribution },
    );
    const producerOperation = await observe(0, "question");
    const decisionSessionId = createUuidV7();
    const decisionOperation = operation();
    await host.workspaceApply({
      operationId: decisionOperation,
      intent: {
        kind: "create_agent_runtime_session",
        decision_run: { kind: "routing", request_id: createUuidV7(), generation: 1 },
        session_id: decisionSessionId,
        project_id: null,
        title: "Nodex · Routing",
        initial_page_ids: [],
        runtime_id: "runtime:host-members",
        runtime_thread_id: "thread:decision",
        launch_request_id: "launch:decision",
      },
    });
    // Storage inspection proves canonical LocalCommit evidence; no fixture writes bypass Core.
    const database = new DatabaseSync(join(scenario.profile.nodexHome, "nodex.db"), {
      readOnly: true,
    });
    try {
      const actor = (id: string) => {
        const row = database
          .prepare("SELECT actor_json FROM local_commits WHERE operation_id=?")
          .get(id) as { actor_json: string } | undefined;
        if (!row) throw new Error(`Missing LocalCommit for ${id}`);
        return JSON.parse(row.actor_json) as unknown;
      };
      expect(actor(assignmentOperation)).toEqual({
        type: "member",
        member_id: alice.identity.member_id,
      });
      expect(actor(startOperation)).toEqual({ type: "member", member_id: bob.identity.member_id });
      expect(actor(bindingOperation)).toEqual({ type: "service", kind: "agent_runtime" });
      expect(actor(agentOperation)).toEqual({
        type: "agent",
        session_id: sessionId,
        run_id: runId,
        on_behalf_of: bob.identity.member_id,
      });
      expect(actor(queuedOperation)).toEqual({
        type: "agent",
        session_id: sessionId,
        run_id: queuedRun,
        on_behalf_of: bob.identity.member_id,
      });
      expect(actor(producerOperation)).toEqual({ type: "service", kind: "agent_runtime" });
      expect(actor(decisionOperation)).toEqual({ type: "service", kind: "agent_runtime" });
      const decisionGrant = database
        .prepare(
          "SELECT commit_row.authorizing_member_id, request.member_id FROM local_commits commit_row JOIN session_requesting_members request ON request.session_id=? AND request.message_id='session:created' WHERE commit_row.operation_id=?",
        )
        .get(decisionSessionId, decisionOperation) as {
        authorizing_member_id: string;
        member_id: string;
      };
      expect(decisionGrant.authorizing_member_id).toBe(decisionGrant.member_id);
      expect(decisionGrant.member_id).not.toBe(alice.identity.member_id);
      expect(decisionGrant.member_id).not.toBe(bob.identity.member_id);
    } finally {
      database.close();
    }
    await alice.client.workspaceApply({
      operationId: operation(),
      intent: {
        kind: "mutate_session",
        session_id: sessionId,
        intent: { kind: "set_unread", unread: true },
      },
    });
    const provenance = {
      profile_id: host.handshake.generation.profile_id,
      authority: {
        thread_id: "thread:host-members",
        root_thread_id: "thread:host-members",
        turn_id: runId,
        actor_project_id: scenario.manifest.projectId,
        library_id: host.handshake.library_id,
        store_epoch: host.handshake.store_epoch,
        runtime: { session_id: sessionId, runtime_id: "runtime:host-members", turn_kind: "run" },
      },
    } satisfies components["schemas"]["AgentTurnProvenance"];
    const bobSnooze = new Date(Date.now() + 3_600_000).toISOString();
    await host.workspaceApply({
      operationId: operation(),
      intent: {
        kind: "agent_command",
        provenance,
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: { kind: "set_snooze", snoozed_until: bobSnooze },
        },
      },
    });
    const agentAttention = () =>
      host.workspaceRead({ kind: "agent_session", session_id: sessionId, provenance });
    expect((await agentAttention()).value).toMatchObject({
      kind: "agent_session",
      session: { snoozed_until: bobSnooze },
      member_requests: { personal: false, pending: [{ id: "question", kind: "question" }] },
    });
    expect(
      (await host.workspaceRead({ kind: "session_detail", session_id: sessionId })).value,
    ).toMatchObject({ kind: "session_detail", session: { snoozed_until: null } });
    // Remove the snooze before reading the Member's Inbox below.
    await host.workspaceApply({
      operationId: operation(),
      intent: {
        kind: "agent_command",
        provenance,
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: { kind: "set_snooze", snoozed_until: null },
        },
      },
    });
    const attention = (client: CoreClient) =>
      relay(client, { operation: "session_read", input: { sessionId } }, async (options) => ({
        session: (await host.workspaceRead({ kind: "session", session_id: sessionId }, options))
          .value,
        inbox: (
          await host.workspaceRead(
            {
              kind: "inbox_window",
              scope: { kind: "all" },
              filter: "inbox",
              window: { first: 20 },
            },
            options,
          )
        ).value,
        counts: (await host.workspaceRead({ kind: "inbox_counts" }, options)).value,
      }));
    const aliceAttention = await attention(alice.client);
    const bobAttention = await attention(bob.client);
    expect(aliceAttention.session).toMatchObject({ kind: "session", session: { unread: true } });
    expect(bobAttention.session).toMatchObject({ kind: "session", session: { unread: false } });
    if (aliceAttention.inbox.kind !== "inbox_window" || bobAttention.inbox.kind !== "inbox_window")
      throw new Error("Missing Inbox window");
    expect(aliceAttention.inbox.items.items.some((item) => item.page_id === pageId)).toBe(false);
    const question = bobAttention.inbox.items.items.find((item) => item.page_id === pageId)!;
    expect(question.turn?.turn.actor).toEqual({
      kind: "member",
      member_id: bob.identity.member_id,
    });
    expect(aliceAttention.counts).not.toEqual(bobAttention.counts);
    const response: HostCall = {
      operation: "session_respond",
      input: { sessionId, runId, requestId: "question", answers: { choice: "Yes" } },
    };
    const availability: string[] = [];
    // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- The real HTTPS scenario owns a Promise callback; this scoped authority must run inside that lifetime.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const access = yield* CoreSessionAccess;
          const result = yield* Effect.result(
            access.use("refused-answer", (client) => client.hostCall!(response)),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.cause).toBeInstanceOf(CoreHttpError);
          const inbox = yield* access.use("inbox-after-refusal", (client) =>
            client.workspaceRead({ kind: "inbox_counts" }),
          );
          expect(inbox.value.kind).toBe("inbox_counts");
        }).pipe(
          Effect.provide(
            RemoteSpaceAuthority.live({
              credential: {
                ...listener,
                spaceId: alice.identity.space_id,
                memberId: alice.identity.member_id,
                deviceId: alice.identity.device_id,
                deviceCredential: alice.identity.device_credential,
                name: "Team",
              },
              buildId: "operation-refusal",
              connect: async () => alice.client,
              observe: (state) =>
                Effect.sync(() => {
                  availability.push(state);
                }),
            }),
          ),
        ),
      ),
    );
    expect(availability).toEqual(["ready"]);
    await relay(bob.client, response, (options) =>
      host.workspaceRead({ kind: "session", session_id: sessionId }, options),
    );
    const reply = {
      kind: "reply_to_page_turn" as const,
      page_id: pageId,
      episode: question.turn!.turn.episode,
      body: "Yes",
      dispatch: {
        type: "answer" as const,
        response: { request_id: "question", run_id: runId, question_id: "choice", answer: "Yes" },
      },
    };
    await expect(
      alice.client.workspaceApply({ operationId: operation(), intent: reply }),
    ).rejects.toThrow(/another Member/u);
    const answerOperation = operation();
    await bob.client.workspaceApply({ operationId: answerOperation, intent: reply });
    await expect(
      alice.client.workspaceApply({ operationId: answerOperation, intent: reply }),
    ).rejects.toThrow();
    await observe(1, "approval");
    expect((await agentAttention()).value).toMatchObject({
      kind: "agent_session",
      member_requests: { personal: false, pending: [] },
    });
    const approval: HostCall = {
      operation: "session_respond",
      input: { sessionId, runId, requestId: "approval", decision: "accept" },
    };
    await expect(bob.client.hostCall(approval)).rejects.toThrow(/belongs to another Member/u);
    await expect(
      bob.client.hostCall({
        ...approval,
        input: { sessionId, runId, requestId: "approval", answers: { choice: "Yes" } },
      }),
    ).rejects.toThrow(/belongs to another Member/u);
    await relay(alice.client, approval, (options) =>
      host.workspaceRead({ kind: "session", session_id: sessionId }, options),
    );
    await host.spaceRemoveMember({ member_id: bob.identity.member_id });
    const failure = {
      status: 404,
      coreError: {
        code: "agent_session_unavailable",
        message:
          "The Agent Session is archived, missing, or no longer has an eligible Member. Reopen the Session in Nodex or start a new one.",
      },
    };
    await expect(
      host.issueAgentAttribution({
        session_id: sessionId,
        run_id: runId,
        driver: "codex",
        label: "Codex",
      }),
    ).rejects.toMatchObject(failure);
    await expect(
      admin.requestJson("GET", "/core/v1/identity", undefined, {
        ...headers,
        "x-nodex-agent-attribution": attribution,
      }),
    ).rejects.toMatchObject(failure);
  });
});
