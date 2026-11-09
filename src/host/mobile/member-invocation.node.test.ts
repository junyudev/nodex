/* @effect-diagnostics asyncFunction:off nodeBuiltinImport:off preferSchemaOverJson:off -- This scenario exercises real Core admission and canonical read-only Actor evidence. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { CoreClient } from "../../main/core-client/core-client";
import { enrollRemoteCore } from "../../main/core-client/remote-http";
import { CoreAuthority, CoreSessionAccess } from "../../main/core-runtime/CoreAuthority";
import { live as modules } from "../../main/core-runtime/CoreModules";
import { coreRuntimeError } from "../../main/core-runtime/CoreRuntimeError";
import { StoreAdministration } from "../../main/core-runtime/StoreAdministration";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { DEFAULT_INBOX_SETTINGS } from "../../shared/inbox";
import { createBoundedOperationId } from "../../shared/operation-identity";
import { createUuidV7 } from "../../shared/uuid-v7";
import { HostInvocation } from "../HostInvocation";
import { InboxApplication, make as makeInbox } from "../inbox-application/InboxApplication";
import { WorkApplication } from "../work-application/WorkApplication";
import { live as phoneFiles } from "../../main/platform/node/PhoneFiles";
import { makeMobileInbox, mobileOperationId } from "./inbox";

const operation = () => createBoundedOperationId("phone.member");

test("the phone façade retains the invoking Member's Turns and capture Actor", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "phone-member-proof",
    });
    const listener = await host.listenSpace({ address: "127.0.0.1:0", cert: null, key: null });
    const enroll = async (name: string) => {
      const invite = await host.spaceInvite({ role: "member" });
      const identity = await enrollRemoteCore(listener, {
        code: invite.code,
        display_name: name,
        device_label: `${name}'s phone`,
        form_factor: "phone",
      });
      const client = await CoreClient.connectRemote({
        ...listener,
        deviceCredential: identity.device_credential,
        spaceId: identity.space_id,
        buildId: "phone-member-proof",
      });
      return { identity, client };
    };
    const alice = await enroll("Alice");
    const bob = await enroll("Bob");
    const lease = await host.registerHost({ instance: createUuidV7() });
    const invoke = async <A>(member: typeof bob, use: (proof: string) => Promise<A>) => {
      const pending = member.client.hostCall({ operation: "activity", input: {} });
      const settled = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const invocation = await host.pollHost(lease);
      if (!invocation) throw new Error("Missing Host invocation");
      try {
        return await use(invocation.credential);
      } finally {
        await host.completeHost({
          ...lease,
          id: invocation.id,
          result: { status: "ok", value: null },
        });
        await settled;
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
        title: "Bob's phone Turn",
      },
    });
    const sessionId = createUuidV7();
    await invoke(bob, (proof) =>
      host.forInvocation(proof).workspaceApply({
        operationId: operation(),
        intent: {
          kind: "start_page_work",
          page_id: pageId,
          selection: { instanceId: "codex", model: "model", effort: null },
          session_id: sessionId,
          launch_id: createUuidV7(),
          message_id: createUuidV7(),
          brief: "Work",
          again: false,
          expected_readiness_epoch: null,
          expected_turn_episode: null,
        },
      }),
    );
    await host.workspaceApply({
      operationId: operation(),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: scenario.manifest.projectId,
        title: "Phone work",
        initial_page_ids: [pageId],
        runtime_id: "runtime:phone-members",
        runtime_thread_id: "thread:phone-members",
        launch_request_id: "launch:phone-members",
      },
    });
    const runId = createUuidV7();
    await host.workspaceApply({
      operationId: operation(),
      intent: {
        kind: "record_session_execution",
        session_id: sessionId,
        expected_revision: 0,
        observation: {
          state: "waiting",
          runId,
          runStartedAt: 0,
          pendingRequestIds: ["question"],
          pendingRequests: [
            { id: "question", kind: "question", question: "Continue?", options: ["Yes", "No"] },
          ],
          queue: null,
          terminalStatus: null,
          personStopped: false,
          stalled: false,
          progressFingerprint: "question",
          progressSince: 0,
        },
        events: [],
        resolved_request_ids: [],
      },
    });
    // The host's own catalog resolves the Agent a phone chooses.
    const codex = {
      instanceId: "codex",
      displayName: "Codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: new Date().toISOString(),
      models: [
        { slug: "model", name: "Model", isDefault: true, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    };
    const access = CoreSessionAccess.of({
      handshake: Effect.succeed(host.handshake),
      use: (name, run) =>
        Effect.flatMap(HostInvocation, (proof) =>
          Effect.tryPromise({
            try: (signal) => run(proof ? host.forInvocation(proof) : host, signal),
            catch: (cause) =>
              coreRuntimeError({ operation: name, reason: "operation", retryable: false, cause }),
          }),
        ),
    });
    const inboxLayer = Layer.effect(InboxApplication, makeInbox).pipe(
      Layer.provide(modules.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, access)))),
      Layer.provide(
        Layer.succeed(StoreAdministration, {
          requestErasure: Effect.void,
        } as StoreAdministration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(AgentRuntimeApplication, {
          catalog: () => Effect.succeed([codex]),
          runOutcome: () => Effect.succeed(null),
        } as unknown as AgentRuntimeApplication["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ApplicationSettings, {
          snapshot: () => Effect.succeed({ inbox: DEFAULT_INBOX_SETTINGS }),
        } as unknown as ApplicationSettings["Service"]),
      ),
    );
    const phone = makeMobileInbox({ captureImages: () => Effect.succeed([]) }).pipe(
      Effect.provide(inboxLayer),
      Effect.provide(phoneFiles),
      Effect.provideService(CoreAuthority, {
        identity: {
          libraryId: host.handshake.library_id,
          profileId: host.handshake.generation.profile_id,
          storeEpoch: host.handshake.store_epoch,
        },
      } as CoreAuthority["Service"]),
      Effect.provideService(WorkApplication, {
        startWork: () => Effect.die("No launch"),
        acceptWork: () => Effect.die("No accept"),
      } as WorkApplication["Service"]),
    );
    const captureId = createUuidV7();
    const capturedPage = createUuidV7();
    const read = (proof: string, capture = false) => {
      // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- The authoritative Core scenario owns this Promise lifetime.
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handlers = yield* phone;
            if (capture)
              yield* handlers["inbox.capture"]({
                operationId: captureId,
                pageId: capturedPage,
                documentId: createUuidV7(),
                issuedAt: Number.parseInt(captureId.slice(0, 8) + captureId.slice(9, 13), 16),
                scope: { kind: "library" },
                text: "Captured as Bob",
                fileRefs: [],
              });
            return {
              window: yield* handlers["inbox.window"]({ scope: { kind: "all" }, filter: "inbox" }),
              // A phone keeps a Page's notification only while that Page's Turn is its Member's.
              turns: yield* handlers["inbox.turns"]({ pageIds: [pageId, capturedPage] }),
            };
          }).pipe(Effect.provideService(HostInvocation, proof)),
        ),
      );
    };
    const alicePhone = await invoke(alice, (proof) => read(proof));
    const bobPhone = await invoke(bob, (proof) => read(proof, true));
    // With the laptop closed, Bob starts a chat from his capture through the Space host.
    const started = await invoke(bob, (proof) =>
      // oxlint-disable-next-line nodex/no-manual-effect-runtime-in-tests -- The authoritative Core scenario owns this Promise lifetime.
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handlers = yield* phone;
            return yield* handlers["inbox.decide"]({
              entryId: capturedPage,
              operationId: createUuidV7(),
              decision: {
                type: "start_chat",
                projectId: null,
                prompt: null,
                agent: { providerInstanceId: "codex", model: "model" },
              },
            });
          }).pipe(Effect.provideService(HostInvocation, proof)),
        ),
      ),
    );
    expect(started.sessionId).toEqual(expect.any(String));
    expect(
      alicePhone.window.items.some((item) => item.rowKind === "turn" && item.pageId === pageId),
    ).toBe(false);
    expect(
      bobPhone.window.items.find((item) => item.rowKind === "turn" && item.pageId === pageId),
    ).toMatchObject({ rowKind: "turn", turn: { reason: "question" } });
    expect(alicePhone.turns).toEqual({ pageIds: [] });
    expect(bobPhone.turns).toEqual({ pageIds: [pageId] });
    const database = new DatabaseSync(join(scenario.profile.nodexHome, "nodex.db"), {
      readOnly: true,
    });
    try {
      const commit = database
        .prepare("SELECT actor_json FROM local_commits WHERE operation_id=?")
        .get(
          mobileOperationId(
            "mobile.inbox.capture",
            captureId,
            Number.parseInt(captureId.slice(0, 8) + captureId.slice(9, 13), 16),
          )!,
        ) as { actor_json: string };
      expect(JSON.parse(commit.actor_json)).toEqual({
        type: "member",
        member_id: bob.identity.member_id,
      });
      // The chat is queued for the host's delivery and answers to Bob, who started it.
      expect(
        database
          .prepare(
            "SELECT proposal.state, json_extract(proposal.confirmed_actor_json,'$.member_id') AS actor, requester.member_id AS requester FROM inbox_proposals proposal JOIN session_requesting_members requester ON requester.session_id=? WHERE proposal.dispatch_session_id=?",
          )
          .get(started.sessionId, started.sessionId),
      ).toEqual({
        state: "dispatching",
        actor: bob.identity.member_id,
        requester: bob.identity.member_id,
      });
    } finally {
      database.close();
    }
  });
});
