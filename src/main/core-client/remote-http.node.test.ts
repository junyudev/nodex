import { expect, test, vi } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { parsePageWork } from "../../shared/work-graph";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { CoreClient } from "./core-client";
import { CoreHttpError, LocalHttpTransport } from "./local-http";
import { readCoreRuntimeConnection } from "./runtime-descriptor";
import { enrollRemoteCore, RemoteHttpTransport, RemoteAccessWithdrawnError } from "./remote-http";
import type { components } from "@nodex/core-protocol";

/** Core's authenticated Device window (`nodex_core_server::DEVICE_REQUESTS_PER_MINUTE`). */
const DEVICE_REQUESTS_PER_MINUTE = 1_200;

const verifyRemoteSources = async (
  host: CoreClient,
  remotes: readonly CoreClient[],
): Promise<void> => {
  const sourceId = "github-transport-test";
  const config = {
    host: "github.com",
    account_login: "alice",
    account_id: "1",
    credential_ref: "gh:github.com:alice",
    repositories: [{ id: "10", name: "alice/repo", enabled: true }],
    discovery: { assigned: true, review_requests: true, mentions: true },
  };
  const configure = {
    kind: "configure_source",
    source_id: sourceId,
    expected_revision: 0,
    enabled: true,
    config,
  } as const;
  const configured = await host.workspaceApply({
    operationId: createBoundedOperationId("configure-source"),
    intent: { kind: "source", command: configure },
  });
  expect(configured.status).toBe("committed");
  const reads: components["schemas"]["SourceRead"][] = [
    { kind: "sources", after_id: null, limit: 10 },
    { kind: "positions", source_id: sourceId, after_partition: null, limit: 10 },
    { kind: "threads", host: "github.com", repository_id: "10", after_id: null, limit: 10 },
    {
      kind: "triggers",
      thread_url: "https://github.com/alice/repo/issues/1",
      before_id: null,
      limit: 10,
    },
    { kind: "open_problems", source_id: sourceId, after_id: null, limit: 10 },
    { kind: "known_pull_requests", after_page_id: null, limit: 10 },
    { kind: "page_follows", page_id: "page", after_thread_id: null, limit: 10 },
    { kind: "deliveries", page_id: null, state: "unresolved", after_id: null, limit: 10 },
  ];
  const commands: components["schemas"]["SourceCommand"][] = [
    configure,
    { kind: "reply_to_origin", page_id: "page", body: "Started" },
    { kind: "claim_channel_send", id: "outbox", lease_token: "remote", lease_duration_ms: 1000 },
    {
      kind: "settle_channel_send",
      id: "outbox",
      lease_token: "remote",
      receipt: null,
      failure: "No",
      permanent: false,
      credential_invalid: false,
    },
    { kind: "record_thread_delivery_failure", message_id: "message", reason: "Unavailable" },
    {
      kind: "follow_thread",
      source_id: sourceId,
      config_revision: 1,
      thread: {
        id: "github:github.com:10:1",
        host: "github.com",
        repository_id: "10",
        repository: "alice/repo",
        number: 1,
        kind: "issue",
        url: "https://github.com/alice/repo/issues/1",
        title: "Task",
        state: "open",
        observation_revision: 0,
        observations: {},
      },
    },
    {
      kind: "prepare_thread_delivery_batch",
      message_id: "message",
      delivery_ids: ["delivery"],
      body: "GitHub update",
    },
    { kind: "begin_thread_delivery_batch", message_id: "message" },
    {
      kind: "settle_thread_delivery_batch",
      message_id: "message",
      accepted: true,
      receipt: "thread",
    },
    { kind: "invalidate_thread_delivery", delivery_id: "delivery", reason: "Changed target" },
    {
      kind: "claim_source_partition",
      source_id: sourceId,
      config_revision: 1,
      partition: "repo:10",
      lease_token: "remote",
      lease_duration_ms: 10_000,
    },
    {
      kind: "ingest_source_batch",
      source_id: sourceId,
      config_revision: 1,
      partition: "repo:10",
      expected_position: 0,
      lease_token: "remote",
      threads: [],
      triggers: [],
      next_position: { baseline_at_ms: 1, watermark_ms: 1, validators: {}, continuation: null },
      next_poll_at_ms: 0,
      quarantine: [],
    },
    {
      kind: "record_source_failure",
      source_id: sourceId,
      config_revision: 1,
      partition: "repo:10",
      lease_token: "remote",
      problem_kind: "network",
      evidence: {},
      retry_at_ms: 0,
    },
    {
      kind: "record_source_success",
      source_id: sourceId,
      config_revision: 1,
      partition: "repo:10",
      lease_token: "remote",
    },
  ];
  for (const remote of remotes) {
    const activity = await remote.workspaceRead({
      kind: "activity_window",
      scope: { kind: "all" },
      filter: "all",
      window: { after: null, first: 10 },
    });
    expect(activity.value.kind).toBe("activity_window");
    await expect(
      remote.workspaceApply({
        operationId: createBoundedOperationId("retry-missing-problem"),
        intent: {
          kind: "source",
          command: { kind: "retry_problem", problem_id: "missing-problem" },
        },
      }),
    ).rejects.toMatchObject({ coreError: { code: "invalid_input" } });

    await expect(
      remote.workspaceRead({
        kind: "sources",
        read: { kind: "channel_outbox", after_id: null, limit: 10 },
      }),
    ).rejects.toMatchObject({ coreError: { code: "unauthorized" } });

    await expect(
      remote.workspaceRead({
        kind: "sources",
        read: { kind: "delivery_batches", after_message_id: null, limit: 10 },
      }),
    ).rejects.toMatchObject({ coreError: { code: "unauthorized" } });
    for (const read of reads) {
      const snapshot = await remote.workspaceRead({ kind: "sources", read });
      expect(snapshot.value).toMatchObject({ kind: "sources", value: { kind: read.kind } });
    }
    const sources = await remote.workspaceRead({
      kind: "sources",
      read: { kind: "sources", after_id: null, limit: 10 },
    });
    expect(sources.value).toMatchObject({
      kind: "sources",
      value: { sources: expect.arrayContaining([expect.objectContaining({ id: sourceId })]) },
    });
    for (const command of commands) {
      await expect(
        remote.workspaceApply({
          operationId: createBoundedOperationId("remote-source"),
          intent: { kind: "source", command },
        }),
      ).rejects.toMatchObject({ coreError: { code: "unauthorized" } });
    }
  }
};

test("pinned remote clients enroll, collaborate, renew and lose access after device revocation", async () => {
  await withCoreScenario(
    { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
    async ({ profile }) => {
      const runtime = readCoreRuntimeConnection(profile.nodexHome);
      const local = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
      const listener = await local.requestJson<components["schemas"]["ListenerInfo"]>(
        "POST",
        "/core/v1/admin/space/listen",
        { address: "127.0.0.1:0" },
      );
      const invite = await local.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "member" },
      );
      await local.requestJson("POST", "/core/v1/admin/space/name", { name: "Platform" });
      const enrollment = { code: invite.code, device_label: "Laptop", display_name: "Bob" };
      await expect(
        enrollRemoteCore({ ...listener, fingerprint: "0".repeat(64) }, enrollment),
      ).rejects.toThrow();
      const device = await enrollRemoteCore(listener, enrollment);
      expect(device.space_name).toBe("Platform");
      await expect(enrollRemoteCore(listener, enrollment)).rejects.toMatchObject({ status: 401 });
      const input = {
        ...listener,
        deviceCredential: device.device_credential,
        spaceId: device.space_id,
        buildId: "remote-client-test",
      };
      const remote = await CoreClient.connectRemote(input);
      expect(remote.spaceName).toBe("Platform");
      await local.requestJson("POST", "/core/v1/admin/space/name", { name: "Delivery" });
      expect((await CoreClient.connectRemote(input)).spaceName).toBe("Delivery");
      await expect(remote.renameSpace("Refused")).rejects.toMatchObject({ status: 403 });
      const host = await CoreClient.connect({
        nodexHome: profile.nodexHome,
        clientKind: "electron_host",
        buildId: "sources-host-test",
      });
      const ownerInvite = await local.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "owner" },
      );
      const ownerDevice = await enrollRemoteCore(listener, {
        code: ownerInvite.code,
        device_label: "Owner laptop",
        display_name: "Owner",
      });
      const remoteOwner = await CoreClient.connectRemote({
        ...input,
        deviceCredential: ownerDevice.device_credential,
      });
      const linked = await remote.spaceLinkDevice();
      expect(linked.member_id).toBe(device.member_id);
      await expect(remote.spaceMembers()).rejects.toMatchObject({ status: 403 });
      expect(
        (await remote.spaceDevices()).every((item) => item.member_id === device.member_id),
      ).toBe(true);
      await remoteOwner.spaceRename({ name: "Owner renamed" });
      const nextInvite = await remoteOwner.spaceInvite({ role: "member" });
      const second = await enrollRemoteCore(nextInvite, {
        code: nextInvite.code,
        device_label: "Second desktop",
        display_name: "Second Member",
      });
      expect(
        (await remoteOwner.spaceMembers()).some((member) => member.id === second.member_id),
      ).toBe(true);
      await remoteOwner.spaceRevokeDevice({ device_id: second.device_id });
      await remoteOwner.spaceRemoveMember({ member_id: second.member_id });
      await verifyRemoteSources(host, [remote, remoteOwner]);
      const members = await remote.libraryRead({ kind: "members" });
      expect(members.value).toMatchObject({
        kind: "members",
        items: expect.arrayContaining([
          expect.objectContaining({ id: device.member_id, role: "member" }),
        ]),
      });
      const operationId = createBoundedOperationId("remote-test");
      const intent = {
        kind: "create_page",
        page_id: crypto.randomUUID(),
        document_id: crypto.randomUUID(),
        title: "Shared remotely",
        parent: { kind: "library", before: null },
      } as const;
      const result = await remote.libraryApply({ operationId, intent });
      expect(result.status).toBe("committed");
      const originalNow = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(originalNow + 3_599_000);
      try {
        const replay = await remote.libraryApply({ operationId, intent });
        expect(replay).toEqual({ ...result, receipt: { ...result.receipt, duplicate: true } });
      } finally {
        clock.mockRestore();
      }
      await expect(remote.administrationRead({ kind: "status" })).rejects.toMatchObject({
        coreError: { code: "unauthorized" },
      });
      await expect(
        remote.libraryRead({ kind: "metadata" }, { class: "maintenance" }),
      ).rejects.toMatchObject({ status: 403 });
      const otherInvite = await local.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "member" },
      );
      const otherDevice = await enrollRemoteCore(listener, {
        code: otherInvite.code,
        device_label: "Other laptop",
        display_name: "Carol",
      });
      const other = await CoreClient.connectRemote({
        ...input,
        deviceCredential: otherDevice.device_credential,
      });
      await expect(other.libraryApply({ operationId, intent })).rejects.toMatchObject({
        coreError: { code: "unauthorized" },
      });
      await expect(
        other.resolveLocalMutation({
          module: "library",
          operation_id: operationId,
          store_epoch: remote.handshake.store_epoch,
          intent_hash: "0".repeat(64),
        }),
      ).rejects.toMatchObject({ status: 403 });
      const transport = new RemoteHttpTransport(input);
      await expect(
        transport.requestJson("POST", "/core/v1/admin/space/invite", { role: "owner" }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        transport.requestJson(
          "POST",
          "/core/v1/modules/library/read",
          { contract_version: 1, read: { kind: "metadata" } },
          { "x-nodex-agent-attribution": "forged" },
        ),
      ).rejects.toMatchObject({
        status: 403,
        coreError: { code: "unauthorized", recovery: { kind: "none" } },
      });
      expect((await remote.libraryRead({ kind: "metadata" })).value.kind).toBe("metadata");
      const lease = await remote.openEventStream(
        0,
        () => {},
        () => {},
      );
      const closed = lease.done.catch(() => {});
      try {
        await local.requestJson("POST", "/core/v1/admin/space/revoke", {
          device_id: device.device_id,
        });
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Revoked stream remained open")),
              4_000,
            );
            timer.unref();
          }),
        ]);
        await expect(remote.libraryRead({ kind: "metadata" })).rejects.toMatchObject({
          status: 401,
        });
        await expect(CoreClient.connectRemote(input)).rejects.toBeInstanceOf(
          RemoteAccessWithdrawnError,
        );
      } finally {
        lease.close();
      }
    },
  );
}, 120_000);

test("ordinary remote reads preserve the TLS admission budget through revocation", async () => {
  await withCoreScenario(
    { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
    async ({ profile }) => {
      const runtime = readCoreRuntimeConnection(profile.nodexHome);
      const local = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
      const listener = await local.requestJson<components["schemas"]["ListenerInfo"]>(
        "POST",
        "/core/v1/admin/space/listen",
        { address: "127.0.0.1:0" },
      );
      const invite = await local.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "member" },
      );
      const device = await enrollRemoteCore(listener, {
        code: invite.code,
        device_label: "Desktop",
        display_name: "Alice",
      });
      const remote = await CoreClient.connectRemote({
        ...listener,
        deviceCredential: device.device_credential,
        spaceId: device.space_id,
        buildId: "desktop-content-burst",
      });
      const stats = () =>
        local.requestJson<components["schemas"]["RemoteTransportStats"]>(
          "GET",
          "/core/v1/admin/space/transport-stats",
        );
      const before = (await stats()).devices[device.device_id]!.requests;
      await Promise.all(Array.from({ length: 32 }, () => remote.libraryRead({ kind: "metadata" })));
      expect((await stats()).devices[device.device_id]!.requests - before).toBe(1);
      // Exceed the TLS accept budget while staying within the ordinary device request budget.
      for (let read = 0; read < 250; read += 1) {
        const result = await remote.libraryRead({ kind: "metadata" });
        expect(result.value.kind).toBe("metadata");
      }
      await local.requestJson("POST", "/core/v1/admin/space/revoke", {
        device_id: device.device_id,
      });
      await expect(remote.libraryRead({ kind: "metadata" })).rejects.toMatchObject({
        status: 401,
      });
    },
  );
}, 120_000);

test("remote budget diagnostics count route templates instead of growing with resource identities", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "route-budget",
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
      device_label: "Route budget",
    });
    const transport = new RemoteHttpTransport({
      ...listener,
      deviceCredential: device.device_credential,
      spaceId: device.space_id,
      buildId: "route-budget",
    });
    const paths = Array.from({ length: 8 }, () => `/core/v1/files/blobs/${createUuidV7()}`);
    for (const path of paths)
      await expect(transport.requestJson("POST", path, {})).rejects.toBeInstanceOf(CoreHttpError);
    const stats = await admin.requestJson<components["schemas"]["RemoteTransportStats"]>(
      "GET",
      "/core/v1/admin/space/transport-stats",
    );
    expect(stats.routes["/core/v1/files/blobs/{file_id}"]).toBe(8);
    expect(Object.keys(stats.routes).some((path) => paths.includes(path))).toBe(false);
  });
});

test("a rate-limited Page edit waits for its device window and commits once without resubmission", async () => {
  await withCoreScenario(
    { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
    async ({ profile }) => {
      const runtime = readCoreRuntimeConnection(profile.nodexHome);
      const admin = new LocalHttpTransport(runtime.descriptor.endpoint, runtime.authCapability);
      const listener = await admin.requestJson<components["schemas"]["ListenerInfo"]>(
        "POST",
        "/core/v1/admin/space/listen",
        { address: "127.0.0.1:0" },
      );
      const invite = await admin.requestJson<components["schemas"]["InviteResponse"]>(
        "POST",
        "/core/v1/admin/space/invite",
        { role: "member" },
      );
      const device = await enrollRemoteCore(listener, {
        code: invite.code,
        device_label: "Budget desktop",
        display_name: "Bob",
      });
      const client = await CoreClient.connectRemote({
        ...listener,
        deviceCredential: device.device_credential,
        spaceId: device.space_id,
        buildId: "budget-retry",
      });
      const stats = () =>
        admin.requestJson<components["schemas"]["RemoteTransportStats"]>(
          "GET",
          "/core/v1/admin/space/transport-stats",
        );
      const pageId = createUuidV7();
      await client.libraryApply({
        operationId: createBoundedOperationId("budget-page"),
        intent: {
          kind: "create_page",
          page_id: pageId,
          document_id: createUuidV7(),
          title: "Pending property edit",
          parent: { kind: "library", before: null },
        },
      });
      const detail = await client.libraryRead({ kind: "page_detail", page_id: pageId });
      if (detail.value.kind !== "page_detail") throw new Error("Missing budget Page");
      const work = detail.value.value.intrinsic_properties.find(
        (property) => property.key === "work",
      )!;
      const initial = (await stats()).devices[device.device_id]!.requests;
      for (let index = initial; index < DEVICE_REQUESTS_PER_MINUTE; index++)
        await client.libraryRead({ kind: "metadata" });
      const operationId = createBoundedOperationId("rate-limited-property");
      const intent = {
        kind: "apply_block_property_mutation" as const,
        mutation: {
          client_session_id: null,
          fields: [
            {
              kind: "intrinsic_set" as const,
              block_id: pageId,
              property_key: "work",
              expected_revision: work.revision,
              value: { ...parsePageWork(work.value)!, owner: device.member_id },
            },
          ],
        },
      };
      const pending = client.libraryApply({ operationId, intent });
      await expect
        .poll(async () => (await stats()).devices[device.device_id]!.refusals, { timeout: 10_000 })
        .toBe(1);
      const result = await pending;
      expect(result.status).toBe("committed");
      const receipt = await client.libraryApply({ operationId, intent });
      expect(receipt.receipt.duplicate).toBe(true);
      if (result.status !== "committed" || receipt.status !== "committed")
        throw new Error("Missing committed Page receipt");
      expect(receipt.commit).toEqual(result.commit);
      const edited = await client.libraryRead({ kind: "page_detail", page_id: pageId });
      if (edited.value.kind !== "page_detail") throw new Error("Missing edited Page");
      const saved = edited.value.value.intrinsic_properties.find(
        (property) => property.key === "work",
      )!;
      expect(saved.revision).toBe(work.revision + 1);
      expect(parsePageWork(saved.value)?.owner).toBe(device.member_id);
      const measured = await stats();
      expect(measured.devices[device.device_id]!.peak_requests).toBe(DEVICE_REQUESTS_PER_MINUTE);
      expect(measured.pre_auth_ips["127.0.0.1"]!.peak_requests).toBeLessThan(20);
    },
  );
}, 120_000);
