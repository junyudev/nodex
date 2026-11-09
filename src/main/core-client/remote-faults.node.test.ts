/* @effect-diagnostics asyncFunction:off nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off -- Real socket faults, deliberate renewal-clock control and read-only durable Actor evidence. */
import { DatabaseSync } from "node:sqlite";
import { setImmediate as socketPoolTurn } from "node:timers/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import type { components } from "@nodex/core-protocol";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createTcpFaultProxy } from "../../../scripts/testing/tcp-fault-proxy";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { parsePageWork } from "../../shared/work-graph";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CoreClient } from "./core-client";
import { LocalHttpTransport, CoreTransportError } from "./local-http";
import { enrollRemoteCore } from "./remote-http";
import { readCoreRuntimeConnection } from "./runtime-descriptor";

const outcome = <A>(promise: Promise<A>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );

test("a lost committed HTTPS response replays one receipt after disconnect and Core restart", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "fault-host",
    });
    const runtime = readCoreRuntimeConnection(scenario.profile.nodexHome);
    const admin = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const proxy = await createTcpFaultProxy(listener.url);
    try {
      const invite = await admin.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "member" },
      );
      const device = await enrollRemoteCore(
        { ...listener, url: proxy.url },
        { code: invite.code, display_name: "Bob", device_label: "Bob desktop" },
      );
      const input = {
        ...listener,
        url: proxy.url,
        deviceCredential: device.device_credential,
        spaceId: device.space_id,
        buildId: "fault-client",
      };
      const bob = await CoreClient.connectRemote(input);
      const operationId = createBoundedOperationId("response-loss");
      const intent = {
        kind: "create_page",
        page_id: createUuidV7(),
        document_id: createUuidV7(),
        title: "One Page",
        parent: { kind: "library", before: null },
      } as const;
      const cursor = bob.handshake.commit_head;
      const stream = await bob.openEventStream(
        cursor,
        () => {},
        () => {},
      );
      const disconnected = outcome(stream.done);
      // The SSE owns one socket. Complete a read on another socket, then let
      // Node publish its `free` event before pausing encrypted responses.
      await bob.libraryRead({ kind: "metadata" });
      await socketPoolTurn();
      proxy.pauseResponses(true);
      let requestSettled = false;
      const lost = outcome(bob.libraryApply({ operationId, intent })).then((result) => {
        requestSettled = true;
        return result;
      });
      await expect
        .poll(async () => {
          const page = await host
            .libraryRead({ kind: "page_detail", page_id: intent.page_id })
            .catch((error) => {
              if (error.coreError?.code === "not_found") return null;
              throw error;
            });
          return page?.value.kind === "page_detail"
            ? (page.value.value.page as { title: string }).title
            : null;
        })
        .toBe("One Page");
      expect(requestSettled).toBe(false);
      await scenario.withStoppedCore(async () => {
        proxy.disconnect();
        proxy.pauseResponses(false);
        expect((await lost).error).toBeInstanceOf(CoreTransportError);
        expect((await disconnected).error).toMatchObject({ kind: "connection_lost" });
      });
      const replacement = await CoreClient.connect({
        nodexHome: scenario.profile.nodexHome,
        clientKind: "electron_host",
        buildId: "fault-restarted-host",
      });
      const nextListener = await replacement.listenSpace({
        address: "127.0.0.1:0",
        cert: null,
        key: null,
      });
      expect(nextListener.fingerprint).toBe(listener.fingerprint);
      proxy.setTarget(nextListener.url);
      const recovered = await CoreClient.connectRemote(input);
      const replay = await recovered.libraryApply({ operationId, intent });
      expect(replay.receipt.duplicate).toBe(true);
      if (replay.status !== "committed") throw new Error("Missing commit");
      const sequences: number[] = [];
      const resumed = await recovered.openEventStream(
        cursor,
        (event) => sequences.push(event.packet.manifest.identity.commit_seq),
        () => {},
      );
      try {
        await expect.poll(() => sequences.includes(replay.commit.commit_seq)).toBe(true);
        expect(sequences.filter((seq) => seq === replay.commit.commit_seq)).toHaveLength(1);
      } finally {
        resumed.close();
      }
      const afterRestart = await recovered.libraryApply({ operationId, intent });
      expect(afterRestart.receipt).toEqual(replay.receipt);
      expect(afterRestart.status).toBe("committed");
      if (afterRestart.status !== "committed") throw new Error("Missing replayed commit");
      expect(afterRestart.commit).toEqual(replay.commit);
      const restartedRuntime = readCoreRuntimeConnection(scenario.profile.nodexHome);
      const restartedAdmin = new LocalHttpTransport(
        restartedRuntime.descriptor.endpoint,
        restartedRuntime.authCapability,
      );
      const otherInvite = await restartedAdmin.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "owner" },
      );
      const aliceDevice = await enrollRemoteCore(nextListener, {
        code: otherInvite.code,
        display_name: "Alice",
        device_label: "Alice desktop",
      });
      const alice = await CoreClient.connectRemote({
        ...nextListener,
        deviceCredential: aliceDevice.device_credential,
        spaceId: device.space_id,
        buildId: "alice",
      });
      await expect(alice.libraryApply({ operationId, intent })).rejects.toMatchObject({
        coreError: { code: "unauthorized" },
      });
    } finally {
      await proxy.close();
    }
  });
}, 120_000);

test("cancelling the first renewal waiter cannot cancel another Member request sharing renewal", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const connection = readCoreRuntimeConnection(scenario.profile.nodexHome);
    const admin = new LocalHttpTransport(connection.descriptor.endpoint, connection.authCapability);
    const listener = await admin.requestJson<components["schemas"]["ListenerInfo"]>(
      "POST",
      "/core/v1/admin/space/listen",
      { address: "127.0.0.1:0" },
    );
    const proxy = await createTcpFaultProxy(listener.url);
    const database = new DatabaseSync(join(scenario.profile.nodexHome, "nodex.db"), {
      readOnly: true,
    });
    try {
      const invite = await admin.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "member" },
      );
      const device = await enrollRemoteCore(
        { ...listener, url: proxy.url },
        { code: invite.code, display_name: "Bob", device_label: "Bob" },
      );
      const client = await CoreClient.connectRemote({
        ...listener,
        url: proxy.url,
        deviceCredential: device.device_credential,
        spaceId: device.space_id,
        buildId: "renewal-race",
      });
      const count = () =>
        (
          database
            .prepare("SELECT count(*) AS count FROM member_sessions WHERE device_id = ?")
            .get(device.device_id) as { count: number }
        ).count;
      const before = count();
      const operations = Array.from({ length: 8 }, () => ({
        operationId: createBoundedOperationId("renewing-write"),
        intent: {
          kind: "create_page" as const,
          page_id: createUuidV7(),
          document_id: createUuidV7(),
          title: "During renewal",
          parent: { kind: "library" as const, before: null },
        },
      }));
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_599_000);
      try {
        proxy.pauseResponses(true);
        const abort = new AbortController();
        const cancelled = outcome(
          client.libraryRead({ kind: "metadata" }, { signal: abort.signal }),
        );
        const survivors = operations.map((input) => outcome(client.libraryApply(input)));
        await expect.poll(count).toBe(before + 1);
        abort.abort();
        expect((await cancelled).error).toMatchObject({ kind: "aborted" });
        proxy.pauseResponses(false);
        for (const result of await Promise.all(survivors)) expect(result.error).toBeUndefined();
        expect(count()).toBe(before + 1);
        for (const operation of operations) {
          const row = database
            .prepare("SELECT actor_json FROM local_commits WHERE operation_id=?")
            .get(operation.operationId) as { actor_json: string };
          expect(JSON.parse(row.actor_json)).toEqual({
            type: "member",
            member_id: device.member_id,
          });
        }
      } finally {
        clock.mockRestore();
      }
    } finally {
      database.close();
      await proxy.close();
    }
  });
}, 60_000);

test("lost Work, Inbox and question responses retain Member receipts and exactly one launch or delivery", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "work-fault-host",
    });
    const runtime = readCoreRuntimeConnection(scenario.profile.nodexHome);
    const admin = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const proxy = await createTcpFaultProxy(listener.url);
    const database = new DatabaseSync(join(scenario.profile.nodexHome, "nodex.db"), {
      readOnly: true,
    });
    try {
      const identities: Record<string, components["schemas"]["EnrollmentResponse"]> = {};
      const enroll = async (name: string, url: string, role: "owner" | "member") => {
        const invite = await admin.requestJson<components["schemas"]["InviteResponse"]>(
          "POST",
          "/core/v1/admin/space/invite",
          { role },
        );
        const identity = await enrollRemoteCore(
          { ...listener, url },
          { code: invite.code, display_name: name, device_label: name },
        );
        identities[name] = identity;
        return CoreClient.connectRemote({
          ...listener,
          url,
          deviceCredential: identity.device_credential,
          spaceId: identity.space_id,
          buildId: name,
        });
      };
      const bob = await enroll("Bob", proxy.url, "member");
      const alice = await enroll("Alice", listener.url, "owner");
      const countReceipt = (id: string) =>
        (
          database
            .prepare("SELECT count(*) AS count FROM core_module_receipts WHERE operation_id=?")
            .get(id) as { count: number }
        ).count;
      const lose = async (intent: components["schemas"]["ProjectWorkspaceIntent"]) => {
        const operationId = createBoundedOperationId(`loss-${intent.kind}`);
        await bob.libraryRead({ kind: "metadata" });
        await socketPoolTurn();
        proxy.pauseResponses(true);
        let requestFailure: unknown;
        const pending = outcome(bob.workspaceApply({ operationId, intent })).then((result) => {
          requestFailure = result.error;
          return result;
        });
        try {
          await expect
            .poll(
              () => {
                if (requestFailure) throw requestFailure;
                return countReceipt(operationId);
              },
              { timeout: 10_000, message: `Missing durable receipt for ${intent.kind}` },
            )
            .toBe(1);
        } catch (error) {
          proxy.pauseResponses(false);
          const rejected = await pending;
          throw rejected.error ?? error;
        }
        proxy.disconnect();
        proxy.pauseResponses(false);
        expect((await pending).error).toBeInstanceOf(CoreTransportError);
        const retry = await bob.workspaceApply({ operationId, intent });
        expect(retry.receipt.duplicate).toBe(true);
        expect(countReceipt(operationId)).toBe(1);
        await expect(alice.workspaceApply({ operationId, intent })).rejects.toMatchObject({
          coreError: { code: "unauthorized" },
        });
        return retry;
      };
      const pageId = createUuidV7();
      const sessionId = createUuidV7();
      const launchId = createUuidV7();
      await host.workspaceApply({
        operationId: createBoundedOperationId("fault-work-page"),
        intent: {
          kind: "create_page_for",
          for: { kind: "project", project_id: scenario.manifest.projectId },
          page_id: pageId,
          document_id: createUuidV7(),
          title: "Bob's work",
        },
      });
      const detail = await bob.libraryRead({ kind: "page_detail", page_id: pageId });
      if (detail.value.kind !== "page_detail") throw new Error("Missing Work Page");
      const work = detail.value.value.intrinsic_properties.find(
        (property) => property.key === "work",
      )!;
      await bob.libraryApply({
        operationId: createBoundedOperationId("bob-work-owner"),
        intent: {
          kind: "apply_block_property_mutation",
          mutation: {
            client_session_id: null,
            fields: [
              {
                kind: "intrinsic_set",
                block_id: pageId,
                property_key: "work",
                expected_revision: work.revision,
                value: { ...parsePageWork(work.value)!, owner: identities.Bob!.member_id },
              },
            ],
          },
        },
      });
      await lose({
        kind: "start_page_work",
        page_id: pageId,
        session_id: sessionId,
        launch_id: launchId,
        message_id: createUuidV7(),
        selection: { instanceId: "codex", model: "model", effort: null },
        brief: "Work",
        again: false,
        expected_readiness_epoch: null,
        expected_turn_episode: null,
      });
      const launches = await host.workspaceRead({ kind: "page_work_outbox", limit: 100 });
      if (launches.value.kind !== "page_work_outbox") throw new Error("Missing Work outbox");
      expect(
        launches.value.launches.filter((launch) => launch.launch_id === launchId),
      ).toHaveLength(1);
      const runId = createUuidV7();
      const observe = async (revision: number, waiting: boolean) =>
        host.workspaceApply({
          operationId: createBoundedOperationId("observe-fault-run"),
          intent: {
            kind: "record_session_execution",
            session_id: sessionId,
            expected_revision: revision,
            observation: {
              state: waiting ? "waiting" : "idle",
              runId,
              runStartedAt: 0,
              pendingRequestIds: waiting ? ["question"] : [],
              pendingRequests: waiting
                ? [
                    {
                      id: "question",
                      kind: "question",
                      question: "Continue?",
                      options: ["Yes", "No"],
                    },
                  ]
                : [],
              queue: null,
              terminalStatus: waiting ? null : "completed",
              personStopped: false,
              stalled: false,
              progressFingerprint: waiting ? "question" : "done",
              progressSince: 0,
            },
            events: [],
            resolved_request_ids: waiting ? [] : ["question"],
          },
        });
      await observe(0, true);
      const inbox = (client: CoreClient) =>
        client.workspaceRead({
          kind: "inbox_window",
          scope: { kind: "all" },
          filter: "inbox",
          window: { first: 20 },
        });
      const bobInbox = await inbox(bob);
      if (bobInbox.value.kind !== "inbox_window") throw new Error("Missing Inbox");
      const turn = bobInbox.value.items.items.find((item) => item.page_id === pageId)!.turn!.turn;
      const aliceInbox = await inbox(alice);
      if (aliceInbox.value.kind !== "inbox_window") throw new Error("Missing Alice Inbox");
      expect(aliceInbox.value.items.items.some((item) => item.page_id === pageId)).toBe(false);
      const notifications = await alice.workspaceRead({ kind: "inbox_turn_notifications" });
      if (notifications.value.kind !== "inbox_turn_notifications")
        throw new Error("Missing notification intents");
      expect(notifications.value.intents.some((intent) => intent.page_id === pageId)).toBe(false);
      await expect(
        alice.workspaceApply({
          operationId: createBoundedOperationId("forbidden-claim"),
          intent: { kind: "claim_turn_notification", page_id: pageId, episode: turn.episode },
        }),
      ).rejects.toMatchObject({ coreError: { code: "unauthorized" } });
      await lose({ kind: "claim_turn_notification", page_id: pageId, episode: turn.episode });
      const claimed = await bob.workspaceRead({ kind: "inbox_turn_notifications" });
      if (claimed.value.kind !== "inbox_turn_notifications")
        throw new Error("Missing Bob notification intents");
      expect(claimed.value.intents.some((intent) => intent.page_id === pageId)).toBe(false);
      const answer = {
        kind: "reply_to_page_turn",
        page_id: pageId,
        episode: turn.episode,
        body: "Yes",
        dispatch: {
          type: "answer",
          response: { request_id: "question", run_id: runId, question_id: "choice", answer: "Yes" },
        },
      } as const;
      await expect(
        alice.workspaceApply({
          operationId: createBoundedOperationId("forbidden-answer"),
          intent: answer,
        }),
      ).rejects.toMatchObject({ coreError: { code: "unauthorized" } });
      await lose(answer);
      const delivery = await host.workspaceRead({ kind: "inbox_dispatch_outbox", limit: 100 });
      if (delivery.value.kind !== "inbox_dispatch_outbox") throw new Error("Missing deliveries");
      const answers = delivery.value.dispatches.filter(
        (item) => item.question_response?.request_id === "question",
      );
      expect(answers).toHaveLength(1);
      expect(
        database
          .prepare(
            "SELECT member_id FROM session_requesting_members WHERE session_id=? AND message_id=?",
          )
          .all(sessionId, answers[0]!.message_id),
      ).toEqual([{ member_id: identities.Bob!.member_id }]);
      await bob.workspaceApply({
        operationId: createBoundedOperationId("unread-bob"),
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: { kind: "set_unread", unread: true },
        },
      });
      expect(
        (await alice.workspaceRead({ kind: "session", session_id: sessionId })).value,
      ).toMatchObject({ session: { unread: false } });
      expect(
        (await bob.workspaceRead({ kind: "session", session_id: sessionId })).value,
      ).toMatchObject({ session: { unread: true } });
      await observe(1, false);
      const status = database
        .prepare(
          "SELECT membership.data_source_id, value.property_id, value.revision FROM data_source_property_values value JOIN data_source_page_memberships membership ON membership.id=value.membership_id JOIN data_source_properties property ON property.id=value.property_id WHERE membership.page_block_id=? AND property.name='Status'",
        )
        .get(pageId) as { data_source_id: string; property_id: string; revision: number };
      await bob.databaseApply({
        operationId: createBoundedOperationId("review-fault-work"),
        intent: [
          {
            kind: "edit_property_values",
            edits: [
              {
                address: {
                  page_id: pageId,
                  data_source_id: status.data_source_id,
                  property_id: status.property_id,
                },
                edit: {
                  kind: "replace",
                  expected_value_revision: status.revision,
                  value: { kind: "select", option_id: "review" },
                },
              },
            ],
          },
        ],
      });
      await lose({ kind: "accept_page_work", page_id: pageId, expected_turn_episode: null });
      const messagePageId = createUuidV7();
      await bob.workspaceApply({
        operationId: createBoundedOperationId("inbox-note"),
        intent: {
          kind: "send_inbox_message",
          page_id: messagePageId,
          document_id: createUuidV7(),
          body: "Keep this note",
          title: null,
          project_id: null,
          reply_to_page_id: null,
          expected_store_epoch: null,
        },
      });
      const coordinatorSession = createUuidV7();
      await host.workspaceApply({
        operationId: createBoundedOperationId("answer-coordinator"),
        intent: {
          kind: "create_agent_runtime_session",
          coordinator: true,
          session_id: coordinatorSession,
          project_id: null,
          title: "Nodex",
          initial_page_ids: [],
          runtime_id: "runtime:fault-answers",
          runtime_thread_id: "thread:fault-answers",
          launch_request_id: "launch:fault-answers",
        },
      });
      const coordinatorRun = createUuidV7();
      const coordinator = await host.issueAgentAttribution({
        session_id: coordinatorSession,
        run_id: coordinatorRun,
        backend: "codex",
      });
      const privateAnswers: string[] = [];
      for (const client of [alice, bob]) {
        const questionPage = createUuidV7();
        const answerPage = createUuidV7();
        privateAnswers.push(answerPage);
        await client.workspaceApply({
          operationId: createBoundedOperationId("member-question"),
          intent: {
            kind: "send_inbox_message",
            page_id: questionPage,
            document_id: createUuidV7(),
            body: "What is waiting?",
            title: null,
            project_id: null,
            reply_to_page_id: null,
            expected_store_epoch: null,
          },
        });
        await host.workspaceApply(
          {
            operationId: createBoundedOperationId("member-answer"),
            intent: {
              kind: "agent_command",
              provenance: {
                profile_id: host.handshake.generation.profile_id,
                authority: {
                  thread_id: "thread:fault-answers",
                  root_thread_id: "thread:fault-answers",
                  turn_id: coordinatorRun,
                  actor_project_id: null,
                  library_id: host.handshake.library_id,
                  store_epoch: host.handshake.store_epoch,
                  runtime: {
                    session_id: coordinatorSession,
                    runtime_id: "runtime:fault-answers",
                    turn_kind: "run",
                  },
                },
              },
              intent: {
                kind: "answer_inbox_question",
                question_page_id: questionPage,
                page_id: answerPage,
                document_id: createUuidV7(),
                body: `Private answer for ${answerPage}`,
              },
            },
          },
          { agentAttribution: coordinator },
        );
      }
      await lose({ kind: "keep_inbox_entries", page_ids: [messagePageId] });
      const expectPrivateAnswers = async (client: CoreClient, member: number) => {
        const read = await inbox(client);
        if (read.value.kind !== "inbox_window") throw new Error("Missing private answers");
        expect(
          read.value.items.items
            .filter((item) => privateAnswers.includes(item.page_id))
            .map((item) => item.page_id),
        ).toEqual([privateAnswers[member]]);
      };
      await expectPrivateAnswers(alice, 0);
      await expectPrivateAnswers(bob, 1);
      // Revocation closes an idle stream and a delivered relay, while Alice still reads.
      const lease = await host.registerHost({ instance: createUuidV7() });
      const relay = outcome(bob.hostCall({ operation: "session_read", input: { sessionId } }));
      const invocation = await host.pollHost(lease);
      expect(invocation).not.toBeNull();
      const stream = await bob.openEventStream(
        0,
        () => {},
        () => {},
      );
      const closed = outcome(stream.done);
      proxy.pauseRequestsAfter(64 * 1024);
      const blob = outcome(
        bob.prepareBlob({
          operationId: createBoundedOperationId("revoked-upload"),
          bytes: Buffer.alloc(8 * 1024 * 1024, 7),
        }),
      );
      await expect.poll(() => proxy.requestsPaused).toBe(true);
      const queuedWrite = outcome(
        bob.workspaceApply({
          operationId: createBoundedOperationId("queued-revoked"),
          intent: { kind: "keep_inbox_entries", page_ids: [messagePageId] },
        }),
      );
      const devices = await admin.requestJson<components["schemas"]["MemberDevice"][]>(
        "GET",
        "/core/v1/admin/space/devices",
      );
      const bobDevice = devices.find((device) => device.label === "Bob")!;
      await admin.requestJson("POST", "/core/v1/admin/space/revoke", { device_id: bobDevice.id });
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Revoked stream remained open")), 4_000);
          timer.unref();
        }),
      ]);
      expect((await relay).error).toBeDefined();
      proxy.pauseRequests(false);
      expect((await blob).error).toBeDefined();
      expect((await queuedWrite).error).toBeDefined();
      await expect(
        host.completeHost({ ...lease, id: invocation!.id, result: { status: "ok", value: null } }),
      ).rejects.toBeDefined();
      expect((await alice.libraryRead({ kind: "metadata" })).value.kind).toBe("metadata");
      await expectPrivateAnswers(alice, 0);
    } finally {
      database.close();
      await proxy.close();
    }
  });
}, 120_000);

test("a black-holed pinned TLS handshake returns a typed timeout and releases its socket", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "blackhole-host",
    });
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const proxy = await createTcpFaultProxy(listener.url);
    try {
      proxy.pauseResponses(true);
      await expect(
        enrollRemoteCore(
          { ...listener, url: proxy.url },
          { code: "not-sent-before-the-pin", display_name: "Bob", device_label: "Bob" },
        ),
      ).rejects.toMatchObject({ kind: "timeout", code: "ETIMEDOUT" });
      await expect.poll(() => proxy.connections, { timeout: 3_000 }).toBe(0);
    } finally {
      await proxy.close();
    }
  });
}, 30_000);

test("shared HTTPS reads keep surviving callers and release the socket after the last caller cancels", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "read-owner",
    });
    const runtime = readCoreRuntimeConnection(scenario.profile.nodexHome);
    const admin = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const invite = await admin.requestJson<components["schemas"]["InviteResponse"]>(
      "POST",
      "/core/v1/admin/space/invite",
      { role: "member" },
    );
    const device = await enrollRemoteCore(listener, {
      code: invite.code,
      display_name: "Bob",
      device_label: "Read owner",
    });
    const proxy = await createTcpFaultProxy(listener.url);
    try {
      const client = await CoreClient.connectRemote({
        ...listener,
        url: proxy.url,
        deviceCredential: device.device_credential,
        spaceId: device.space_id,
        buildId: "read-owner",
      });
      const count = async () =>
        (
          await admin.requestJson<components["schemas"]["RemoteTransportStats"]>(
            "GET",
            "/core/v1/admin/space/transport-stats",
          )
        ).routes["/core/v1/modules/library/read"] ?? 0;
      await client.libraryRead({ kind: "metadata" });
      await socketPoolTurn();
      let before = await count();
      proxy.pauseResponses(true);
      const first = new AbortController();
      const second = new AbortController();
      const cancelled = outcome(client.libraryRead({ kind: "metadata" }, { signal: first.signal }));
      const surviving = outcome(
        client.libraryRead({ kind: "metadata" }, { signal: second.signal }),
      );
      await expect.poll(async () => (await count()) - before).toBe(1);
      first.abort();
      expect((await cancelled).error).toMatchObject({ kind: "aborted" });
      proxy.pauseResponses(false);
      expect((await surviving).value?.value.kind).toBe("metadata");
      await socketPoolTurn();
      before = await count();
      proxy.pauseResponses(true);
      const last = new AbortController();
      const abandoned = outcome(client.libraryRead({ kind: "metadata" }, { signal: last.signal }));
      await expect.poll(async () => (await count()) - before).toBe(1);
      const closed = proxy.accepted - proxy.connections;
      last.abort();
      expect((await abandoned).error).toMatchObject({ kind: "aborted" });
      // Module cancellation may open its own bounded control request. The
      // abandoned read's socket must close even while that reply is paused.
      await expect
        .poll(() => proxy.accepted - proxy.connections, { timeout: 3_000 })
        .toBe(closed + 1);
      proxy.pauseResponses(false);
      before = await count();
      await Promise.all([
        client.libraryRead({ kind: "metadata" }, { deadlineMs: 10_000 }),
        client.libraryRead({ kind: "metadata" }, { deadlineMs: 20_000 }),
      ]);
      expect((await count()) - before).toBe(2);
    } finally {
      await proxy.close();
    }
  });
}, 30_000);
