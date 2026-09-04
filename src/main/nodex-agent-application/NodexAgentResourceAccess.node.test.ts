import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { live as coreModulesLive } from "../core-runtime/CoreModules";
import { live, NodexAgentResourceAccess } from "./NodexAgentResourceAccess";

const identity = {
  libraryId: "library:test",
  profileId: "profile:test",
  storeEpoch: "epoch:test",
} as const;

const authority = {
  threadId: "thread:one",
  turnId: "turn:one",
  rootThreadId: "thread:root",
  actorProjectId: "project:one",
  libraryId: identity.libraryId,
  storeEpoch: identity.storeEpoch,
  frozenAtMs: 1_785_491_085_000,
  scope: "project" as const,
  source: "project_turn" as const,
};

const layerFor = (client: FakeCoreClient) => {
  const handshake = createFakeCoreHandshake(identity);
  const generationClient = Object.assign(client, {
    handshake,
    forProject: () => generationClient,
  }) as unknown as CoreGenerationClient;
  const accessLayer = Layer.succeed(
    CoreSessionAccess,
    CoreSessionAccess.of({
      handshake: Effect.succeed(handshake),
      use: (_operation, run) => Effect.promise((signal) => run(generationClient, signal)),
    }),
  );
  return live.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(CoreAuthority, CoreAuthority.of({ identity } as CoreAuthority["Service"])),
        coreModulesLive.pipe(Layer.provide(accessLayer)),
      ),
    ),
  );
};

it.effect("maps exact Turn resource planning and Core-resolved Page consent", () => {
  const client = new FakeCoreClient();
  client.enqueueRead({
    contract_version: 1,
    commit_head: 8,
    store_epoch: identity.storeEpoch,
    value: {
      kind: "agent_resource_access_plan",
      value: {
        kind: "consent_required",
        requirements: [
          {
            intent: { target: { kind: "page", page_id: "page:owner" }, action: "write" },
            grant: {
              root: { kind: "page", page_id: "page:owner" },
              access: "read_write",
            },
            reason: "grant_missing",
            persistable: true,
          },
        ],
        inspection_access: {
          kind: "inspection",
          scope: "call",
          thread_id: authority.threadId,
          turn_id: authority.turnId,
          call_id: "call:one",
          root_thread_id: authority.rootThreadId,
          actor_project_id: authority.actorProjectId,
          library_id: authority.libraryId,
          store_epoch: authority.storeEpoch,
          grants: [
            {
              root: { kind: "page", page_id: "page:owner" },
              access: "read_write",
            },
          ],
        },
      },
    },
  });

  return Effect.gen(function* () {
    const resources = yield* NodexAgentResourceAccess;
    assert.deepStrictEqual(
      yield* resources.plan({
        authority,
        callId: "call:one",
        intents: [{ target: { kind: "page_or_block", id: "block:nested" }, action: "write" }],
      }),
      {
        kind: "consent_required",
        requirements: [
          {
            intent: { target: { kind: "page", pageId: "page:owner" }, action: "write" },
            grant: {
              root: { kind: "page", pageId: "page:owner" },
              access: "read_write",
            },
            reason: "grant_missing",
            persistable: true,
          },
        ],
        inspectionAccess: {
          kind: "inspection",
          scope: "call",
          threadId: authority.threadId,
          turnId: authority.turnId,
          callId: "call:one",
          rootThreadId: authority.rootThreadId,
          actorProjectId: authority.actorProjectId,
          libraryId: authority.libraryId,
          storeEpoch: authority.storeEpoch,
          grants: [
            {
              root: { kind: "page", pageId: "page:owner" },
              access: "read_write",
            },
          ],
        },
      },
    );
    assert.deepStrictEqual(client.reads, [
      {
        kind: "plan_agent_resource_access",
        provenance: {
          profile_id: identity.profileId,
          authority: {
            thread_id: authority.threadId,
            turn_id: authority.turnId,
            root_thread_id: authority.rootThreadId,
            actor_project_id: authority.actorProjectId,
            library_id: authority.libraryId,
            store_epoch: authority.storeEpoch,
            scope: authority.scope,
            source: authority.source,
          },
        },
        call_id: "call:one",
        intents: [{ target: { kind: "page_or_block", id: "block:nested" }, action: "write" }],
        task_access: null,
      },
    ]);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete resource-access application layer.
  }).pipe(Effect.provide(layerFor(client)));
});

it.effect("persists one canonical Project grant batch through the final capability", () => {
  const client = new FakeCoreClient();
  client.enqueueApply({
    value: {
      page_file_entries: [],
      affected_resource_ids: ["page:one"],
      page_copy: null,
      block_transfer: null,
      page_lifecycle: null,
      block_property_mutation: null,
    },
    receipt: {
      operation_id: "agent-grants:one",
      duplicate: false,
      operation_kind: "persist_agent_project_resource_grants",
      did_mutate: true,
      created_target: null,
      affected_parent_keys: [],
      affected_page_ids: ["page:one"],
      affected_database_ids: [],
      affected_view_ids: [],
      committed_revisions: { "projectGrant:project:one:page:page:one": 1 },
      commit_seq: 9,
      committed_at: "2026-07-20T09:20:00.000Z",
    },
    event_sequence: 9,
    store_epoch: identity.storeEpoch,
  });

  return Effect.gen(function* () {
    const resources = yield* NodexAgentResourceAccess;
    yield* resources.persistProjectGrants({
      operationId: "agent-grants:one",
      authority,
      grants: [
        { root: { kind: "page", pageId: "page:one" }, access: "read" },
        { root: { kind: "page", pageId: "page:one" }, access: "read_write" },
      ],
    });
    assert.deepStrictEqual(client.applies, [
      {
        operationId: "agent-grants:one",
        intent: {
          kind: "persist_agent_project_resource_grants",
          provenance: {
            profile_id: identity.profileId,
            authority: {
              thread_id: authority.threadId,
              turn_id: authority.turnId,
              root_thread_id: authority.rootThreadId,
              actor_project_id: authority.actorProjectId,
              library_id: authority.libraryId,
              store_epoch: authority.storeEpoch,
              scope: authority.scope,
              source: authority.source,
            },
          },
          grants: [
            {
              root: { kind: "page", page_id: "page:one" },
              access: "read_write",
            },
          ],
        },
      },
    ]);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete resource-access application layer.
  }).pipe(Effect.provide(layerFor(client)));
});

it.effect("rejects a Core task overlay outside the frozen Turn boundary", () => {
  const client = new FakeCoreClient();
  client.enqueueRead({
    contract_version: 1,
    commit_head: 8,
    store_epoch: identity.storeEpoch,
    value: {
      kind: "agent_resource_access_plan",
      value: {
        kind: "authorized",
        resource_access: {
          kind: "consent",
          scope: "task",
          root_thread_id: "thread:other",
          actor_project_id: authority.actorProjectId,
          library_id: authority.libraryId,
          store_epoch: authority.storeEpoch,
          grants: [
            {
              root: { kind: "page", page_id: "page:one" },
              access: "read_write",
            },
          ],
        },
      },
    },
  });

  return Effect.gen(function* () {
    const resources = yield* NodexAgentResourceAccess;
    const error = yield* resources
      .plan({
        authority,
        callId: "call:one",
        intents: [{ target: { kind: "page", pageId: "page:one" }, action: "write" }],
      })
      .pipe(Effect.flip);
    assert.match(String(error.cause), /escaped its Turn authority/u);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete resource-access application layer.
  }).pipe(Effect.provide(layerFor(client)));
});
