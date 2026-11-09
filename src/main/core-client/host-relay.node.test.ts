/* @effect-diagnostics asyncFunction:off preferSchemaOverJson:off -- Exercises real HTTPS Member and private Host contracts with disposable Core. */
import { randomUUID } from "node:crypto";
import { expect, test } from "vite-plus/test";
import type { components } from "@nodex/core-protocol";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { CoreClient } from "./core-client";
import { CoreRateLimitError, LocalHttpTransport } from "./local-http";
import { RemoteHttpTransport, enrollRemoteCore } from "./remote-http";
import { readCoreRuntimeConnection } from "./runtime-descriptor";

test("Core relays bounded reads to one Host and preserves the Member's exact delivery authority", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const connectionId = randomUUID();
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "host-relay-test",
      connectionId,
    });
    const connection = readCoreRuntimeConnection(scenario.profile.nodexHome);
    const transport = new LocalHttpTransport(
      connection.descriptor.endpoint,
      connection.authCapability,
    );
    const headers = {
      "x-nodex-connection-id": connectionId,
      "x-nodex-connection-binding": host.handshake.connection_binding,
    };
    // The supplied connection ID is explicit so this fixture can also exercise private administration.
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    // A replacement execution owner reattaches to Core's existing matching listener.
    expect(await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null })).toEqual(
      listener,
    );
    await expect(
      host.listenSpace({ address: "127.0.0.2:0", cert: null, key: null }),
    ).rejects.toThrow(/already enabled/u);
    const invitation = await transport.requestJson<components["schemas"]["InviteResponse"]>(
      "POST",
      "/core/v1/admin/space/invite",
      { role: "member" },
      headers,
    );
    const enrolled = await enrollRemoteCore(listener, {
      code: invitation.code,
      display_name: "Bob",
      device_label: "test desktop",
    });
    const remoteInput = {
      ...listener,
      deviceCredential: enrolled.device_credential,
      spaceId: enrolled.space_id,
      buildId: "member-host-test",
    };
    const member = await CoreClient.connectRemote(remoteInput);
    // Distinct consumers and snapshots exercise Core's queue after Main read coalescing.
    const consumers = await Promise.all(
      Array.from({ length: 3 }, () => CoreClient.connectRemote(remoteInput)),
    );
    expect(await member.hostAvailability()).toEqual({ available: false });
    let lease = await host.registerHost({ instance: randomUUID() });
    expect(await member.hostAvailability()).toEqual({ available: true });
    // An idle long poll must survive the ordinary five-second HTTP liveness timeout.
    expect(await host.pollHost(lease)).toBeNull();
    const waiting = [member, ...consumers].flatMap((consumer) =>
      (["providers", "connection"] as const).map((operation) =>
        consumer.hostCall({ operation, input: {} }),
      ),
    );
    const completed = Promise.all(waiting);
    // Keep all pending calls observed if an earlier queue assertion fails.
    void completed.catch(() => {});
    const delivered = [];
    for (const _call of waiting) {
      const invocation = await host.pollHost(lease);
      if (!invocation) throw new Error("Missing waiting Host call");
      delivered.push(invocation);
    }
    // Slow execution-owner work cannot occupy the Member's content request slots.
    await expect(
      member.workspaceRead({ kind: "project", project_id: scenario.manifest.projectId }),
    ).resolves.toMatchObject({ value: { kind: "project" } });
    const pressure = await member.hostCall({ operation: "activity", input: {} }).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(pressure instanceof CoreRateLimitError))
      throw new Error("Missing typed Host capacity refusal", { cause: pressure });
    expect(pressure.message).toMatch(/queue is full/u);
    const resumedAt = performance.now();
    await member.workspaceRead({ kind: "project", project_id: scenario.manifest.projectId });
    // Cooldown survives the refused call's retry budget, including for a different route.
    expect(performance.now() - resumedAt).toBeGreaterThanOrEqual(pressure.retryAfterMs - 250);
    for (const invocation of delivered)
      await host.completeHost({ ...lease, id: invocation.id, result: { status: "ok", value: [] } });
    await completed;
    const reading = member.hostCall({ operation: "providers", input: {} });
    const read = await host.pollHost(lease);
    if (!read) throw new Error("Missing admitted read");
    expect(read.call.operation).toBe("providers");
    await host.completeHost({ ...lease, id: read.id, result: { status: "ok", value: [] } });
    expect(await reading).toEqual({ status: "ok", value: [] });

    const sessionId = randomUUID();
    const messageId = randomUUID();
    await host.workspaceApply({
      operationId: createBoundedOperationId("host-relay.session"),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: scenario.manifest.projectId,
        title: "Host chat",
        initial_page_ids: [],
        runtime_id: "runtime:host-relay",
        runtime_thread_id: "thread:host-relay",
        launch_request_id: "launch:host-relay",
      },
    });
    const accepted = (message_id: string) => ({
      kind: "mutate_session" as const,
      session_id: sessionId,
      intent: { kind: "record_user_message" as const, message_id },
    });
    await expect(
      member.workspaceApply({
        operationId: createBoundedOperationId("host-relay.forged"),
        intent: accepted(messageId),
      }),
    ).rejects.toThrow(/live Host/u);
    const sending = member.hostCall({
      operation: "session_message",
      input: { sessionId, message: { messageId, text: "Continue" } },
    });
    const send = await host.pollHost(lease);
    if (!send) throw new Error("Missing admitted message");
    const options = { hostInvocation: send.credential };
    await expect(
      host.workspaceApply(
        {
          operationId: createBoundedOperationId("host-relay.wrong-message"),
          intent: accepted("another-message"),
        },
        options,
      ),
    ).rejects.toThrow(/live Host/u);
    await host.workspaceApply(
      { operationId: createBoundedOperationId("host-relay.accepted"), intent: accepted(messageId) },
      options,
    );
    await expect(member.workspaceRead({ kind: "inbox_counts" }, options)).rejects.toThrow();
    await expect(
      host.workspaceApply(
        {
          operationId: createBoundedOperationId("host-relay.admin"),
          intent: { kind: "source", command: { kind: "retry_problem", problem_id: "missing" } },
        },
        { hostInvocation: "forged" },
      ),
    ).rejects.toThrow();
    await host.completeHost({
      ...lease,
      id: send.id,
      result: { status: "ok", value: { sequence: 1 } },
    });
    expect((await sending).status).toBe("ok");
    await expect(host.workspaceRead({ kind: "inbox_counts" }, options)).rejects.toThrow(/expired/u);

    await member.workspaceApply({
      operationId: createBoundedOperationId("host-relay.pause"),
      intent: { kind: "pause_work", scope: { kind: "space" } },
    });
    const holds = await member.workspaceRead({
      kind: "execution_holds",
      after_key: null,
      limit: 100,
    });
    expect(holds.value.kind).toBe("execution_holds");
    if (holds.value.kind === "execution_holds")
      expect(holds.value.holds[0]?.actor).toBe(enrolled.member_id);
    await member.workspaceApply({
      operationId: createBoundedOperationId("host-relay.resume"),
      intent: { kind: "resume_work", scope: { kind: "space" } },
    });

    const interrupted = member
      .hostCall({ operation: "providers", input: {} })
      .catch((error: unknown) => error);
    const interruptedInvocation = await host.pollHost(lease);
    if (!interruptedInvocation) throw new Error("Missing interrupted Host invocation");
    const retiredLease = lease;
    lease = await host.registerHost({ instance: randomUUID() });
    expect(await interrupted).toMatchObject({ status: 503 });
    await expect(
      host.completeHost({
        ...retiredLease,
        id: interruptedInvocation.id,
        result: { status: "ok", value: "late result" },
      }),
    ).rejects.toThrow();
    const fresh = member.hostCall({ operation: "providers", input: {} });
    const freshInvocation = await host.pollHost(lease);
    if (!freshInvocation) throw new Error("Replacement Host did not receive a fresh invocation");
    await host.completeHost({
      ...lease,
      id: freshInvocation.id,
      result: { status: "ok", value: [] },
    });
    expect(await fresh).toEqual({ status: "ok", value: [] });
    await expect(
      host.completeHost({ ...lease, id: freshInvocation.id, result: { status: "ok", value: [] } }),
    ).rejects.toThrow();

    const network = new RemoteHttpTransport(remoteInput);
    await expect(
      network.requestJson("POST", "/core/v1/admin/host/register", { instance: randomUUID() }),
    ).rejects.toThrow();
    const revokedRead = member.hostCall({ operation: "providers", input: {} });
    // Attach rejection before revocation can settle the outstanding request.
    const refused = expect(revokedRead).rejects.toThrow();
    const active = await host.pollHost(lease);
    if (!active) throw new Error("Missing revocation test read");
    await transport.requestJson(
      "POST",
      "/core/v1/admin/space/revoke",
      { device_id: enrolled.device_id },
      headers,
    );
    await expect(
      host.completeHost({
        ...lease,
        id: active.id,
        result: { status: "ok", value: "private transcript" },
      }),
    ).rejects.toThrow();
    await refused;
    const replacement = await host.registerHost({ instance: randomUUID() });
    expect(replacement.token).not.toBe(lease.token);
    await expect(host.pollHost(lease)).rejects.toThrow();
  });
}, 60_000);
