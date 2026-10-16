import { describe, expect, test, vi } from "vite-plus/test";

import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import type { AddressReset } from "../../shared/recipient-delivery";
import type { ProjectionStreamMessage } from "../../shared/projection-stream";
import {
  LocalCommitIngressCapacityError,
  RendererLocalCommitIngress,
} from "./local-commit-ingress";

const scope = {
  kind: "project" as const,
  libraryId: "library-1",
  projectId: "project-1",
};

const libraryScope = {
  kind: "library" as const,
  libraryId: "library-1",
};

const effect = (
  revision: number,
  effectHash = String(revision).padStart(64, "a").slice(-64),
): AuthorizedDeliveryPacket["projection_effects"][number] => ({
  scope: {
    schema_version: 1,
    canonical_key: "page:project-1:page-1",
    scope: {
      kind: "page",
      project_id: "project-1",
      page_id: "page-1",
    },
  },
  base_revision: revision - 1,
  result_revision: revision,
  covered_commit_seq: 1,
  patch: {
    kind: "page_changed",
    project_id: "project-1",
    page_id: "page-1",
  },
  requires_read_at_least: false,
  effect_hash: effectHash,
});

const databaseRowEffect = (
  positionOrder: number,
): AuthorizedDeliveryPacket["projection_effects"][number] => ({
  scope: {
    schema_version: 1,
    canonical_key: "database-view:project-1:view-1",
    scope: {
      kind: "database_view",
      project_id: "project-1",
      database_id: "database-1",
      data_source_id: "source-1",
      view_id: "view-1",
    },
  },
  base_revision: 0,
  result_revision: 1,
  covered_commit_seq: 1,
  patch: {
    kind: "database_row_upsert",
    project_id: "project-1",
    database_id: "database-1",
    data_source_id: "source-1",
    view_id: "view-1",
    row: {
      page_id: "page-1",
      lifecycle: "active",
      title: "Moved Page",
      rich_title: [{ type: "text", text: "Moved Page", styles: {} }],
      description_preview: "",
      description_length: 0,
      has_description: false,
      database_values: { status: "ship" },
      intrinsic_properties: {
        "run.target": "localProject",
        "run.localPath": null,
        "run.baseBranch": null,
        "run.worktreePath": null,
        "run.environmentPath": null,
        "schedule.isAllDay": false,
        "schedule.timezone": null,
        "recurrence.config": null,
        "reminders.config": [],
      },
      database_value_revisions: { status: 2 },
      task_parent_page_id: null,
      task_sibling_rank: null,
      task_parent_value_revision: 1,
      metadata_revision: 2,
      parent_revision: 1,
      document_id: "document-1",
      document_generation: 1,
      document_head_seq: 1,
      membership_id: "membership-1",
      membership_revision: 1,
      membership_created_at: "2026-08-09T00:00:00.000Z",
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
      effective_group_key: "ship",
      rank_key: "rank-page-1",
      position_revision: 2,
      position_order: positionOrder,
    },
    total_rows: 5,
    group_total: 5,
  },
  requires_read_at_least: true,
  effect_hash: "c".repeat(64),
});

type AuthorizedProjectionEffect = AuthorizedDeliveryPacket["projection_effects"][number];

const patchlessEffect = (
  canonicalKey: string,
  projectionScope: AuthorizedProjectionEffect["scope"]["scope"],
  effectHash: string,
): AuthorizedProjectionEffect => ({
  scope: {
    schema_version: 1,
    canonical_key: canonicalKey,
    scope: projectionScope,
  },
  base_revision: 0,
  result_revision: 1,
  covered_commit_seq: 1,
  patch: null,
  requires_read_at_least: true,
  effect_hash: effectHash,
});

const patchlessPageEffect = (pageId = "page-1"): AuthorizedProjectionEffect =>
  patchlessEffect(
    `page:project-1:${pageId}`,
    {
      kind: "page",
      project_id: "project-1",
      page_id: pageId,
    },
    "d".repeat(64),
  );

const packet = (
  input: {
    readonly address?: AuthorizedDeliveryPacket["delivery_address"];
    readonly projections?: AuthorizedDeliveryPacket["projection_effects"];
    readonly documents?: AuthorizedDeliveryPacket["document_effects"];
    readonly atoms?: AuthorizedDeliveryPacket["atoms"];
    readonly packetHash?: string;
  } = {},
): AuthorizedDeliveryPacket => {
  const projections = input.projections ?? [effect(1)];
  const documents = input.documents ?? [];
  const atoms = input.atoms ?? [];
  const address = input.address ?? {
    kind: "project" as const,
    library_id: "library-1",
    project_id: "project-1",
  };
  return {
    packet_version: 5,
    delivery_address: address,
    manifest: {
      event_version: 8,
      identity: {
        store_epoch: "epoch-1",
        commit_seq: 1,
        manifest_hash: "1".repeat(64),
      },
      operation_id: "operation-1",
      committed_at: "2026-08-09T00:00:00.000Z",
    },
    atoms,
    document_effects: documents,
    projection_effects: projections,
    coverage: {
      atom_ids: atoms.map((atom) => atom.descriptor.atom_id),
      document_effect_orders: documents.map((item) => item.reference.effect_order),
      inline_document_effect_orders: documents
        .filter((item) => item.inline_update !== null && item.inline_update !== undefined)
        .map((item) => item.reference.effect_order),
      projection_scope_keys: projections.map((item) => item.scope.canonical_key),
    },
    packet_hash: input.packetHash ?? "2".repeat(64),
  };
};

const apply = (delivery: AuthorizedDeliveryPacket) => ({
  status: "committed" as const,
  commit: delivery.manifest.identity,
  delivery,
});

const addressReset = (overrides: Partial<AddressReset> = {}): AddressReset => ({
  reset_id: "a".repeat(64),
  recipient_lease_id: "b".repeat(64),
  delivery_address: {
    kind: "project",
    library_id: "library-1",
    project_id: "project-1",
  },
  store_epoch: "epoch-1",
  required_commit_seq: 1,
  reason: "ack_timeout",
  ...overrides,
});

describe("RendererLocalCommitIngress", () => {
  test("admits distinct subscription checkpoints while deduplicating exact retries and preserving real resets", () => {
    const ingress = new RendererLocalCommitIngress();
    const projection = vi.fn();
    ingress.subscribeProjection(scope, projection);
    const identity = {
      deliveryId: "c".repeat(64),
      recipientLeaseId: "b".repeat(64),
      deliveryAddress: addressReset().delivery_address,
    };
    const stream = { storeEpoch: "epoch-1", commitSeq: 1 };
    ingress.admitAddressCheckpoint(identity, stream);
    ingress.admitAddressCheckpoint(identity, stream);
    expect(projection).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenLastCalledWith({ version: 2, kind: "checkpoint", scope, stream });
    expect(() => ingress.admitAddressCheckpoint(identity, { ...stream, commitSeq: 2 })).toThrow(
      "identity collision",
    );
    ingress.admitAddressCheckpoint(
      { ...identity, deliveryId: "d".repeat(64) },
      { ...stream, commitSeq: 2 },
    );
    ingress.admitAddressReset(addressReset({ required_commit_seq: 2 }));
    expect(projection.mock.calls.map(([message]) => message.kind)).toEqual([
      "checkpoint",
      "checkpoint",
      "reset",
    ]);
    expect(() =>
      ingress.admitAddressCheckpoint(
        { ...identity, deliveryId: "e".repeat(64) },
        { ...stream, commitSeq: -1 },
      ),
    ).toThrow("invalid");
    expect(() =>
      ingress.admitAddressCheckpoint(
        { ...identity, deliveryAddress: { kind: "library", library_id: " " } },
        stream,
      ),
    ).toThrow("invalid");
  });

  test("deduplicates an address reset retry by its immutable reset identity", () => {
    const ingress = new RendererLocalCommitIngress();
    const projection = vi.fn();
    ingress.subscribeProjection(scope, projection);

    const reset = addressReset();
    ingress.admitAddressReset(reset);
    ingress.admitAddressReset(reset);

    expect(projection).toHaveBeenCalledTimes(1);
    expect(() =>
      ingress.admitAddressReset(
        addressReset({
          required_commit_seq: 2,
        }),
      ),
    ).toThrow("identity collision");
  });

  test("keeps another address packet deduplicated after a scoped reset", async () => {
    const ingress = new RendererLocalCommitIngress();
    const projectTwoScope = {
      kind: "project" as const,
      libraryId: "library-1",
      projectId: "project-2",
    };
    const projectTwoListener = vi.fn();
    ingress.subscribeProjection(projectTwoScope, projectTwoListener);
    const projectTwoPacket = packet({
      address: {
        kind: "project",
        library_id: "library-1",
        project_id: "project-2",
      },
      projections: [
        {
          ...effect(1),
          scope: {
            ...effect(1).scope,
            canonical_key: "page:project-2:page-1",
            scope: {
              kind: "page",
              project_id: "project-2",
              page_id: "page-1",
            },
          },
          patch: {
            kind: "page_changed",
            project_id: "project-2",
            page_id: "page-1",
          },
        },
      ],
      packetHash: "7".repeat(64),
    });

    await ingress.admitPacket(projectTwoPacket);
    ingress.admitAddressReset(addressReset());
    await expect(ingress.admitPacket(projectTwoPacket)).resolves.toMatchObject({
      kind: "duplicate",
    });

    expect(projectTwoListener).toHaveBeenCalledTimes(1);
  });

  test("publishes the origin projection before apply admission resolves", async () => {
    const ingress = new RendererLocalCommitIngress();
    const order: string[] = [];
    ingress.subscribeProjection(scope, () => order.push("projection"));

    await ingress.admitApply(apply(packet())).then(() => order.push("resolved"));

    expect(order).toEqual(["projection", "resolved"]);
  });

  test("preserves the Page dependency of a patchless projection effect", async () => {
    const ingress = new RendererLocalCommitIngress();
    const messages: ProjectionStreamMessage[] = [];
    ingress.subscribeProjection(libraryScope, (message) => messages.push(message));

    await ingress.admitPacket(
      packet({
        address: {
          kind: "library",
          library_id: "library-1",
        },
        projections: [patchlessPageEffect("page-1")],
      }),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        kind: "effect",
        delivery: expect.objectContaining({
          impact: {
            kind: "resources",
            page_ids: ["page-1"],
            database_ids: [],
            data_source_ids: [],
            view_ids: [],
            document_heads: [],
          },
        }),
      }),
    ]);
  });

  test("derives safe repair impacts from every patchless aggregate scope", async () => {
    const ingress = new RendererLocalCommitIngress();
    const messages: ProjectionStreamMessage[] = [];
    ingress.subscribeProjection(libraryScope, (message) => messages.push(message));

    await ingress.admitPacket(
      packet({
        address: {
          kind: "library",
          library_id: "library-1",
        },
        projections: [
          patchlessEffect(
            "database-view:project-1:view-1",
            {
              kind: "database_view",
              project_id: "project-1",
              database_id: "database-1",
              data_source_id: "source-1",
              view_id: "view-1",
            },
            "e".repeat(64),
          ),
          patchlessEffect(
            "project:project-1",
            { kind: "project", project_id: "project-1" },
            "f".repeat(64),
          ),
          patchlessEffect(
            "library:library-1",
            { kind: "library", library_id: "library-1" },
            "0".repeat(64),
          ),
        ],
      }),
    );

    expect(
      messages.map((message) => (message.kind === "effect" ? message.delivery.impact : null)),
    ).toEqual([
      {
        kind: "resources",
        page_ids: [],
        database_ids: ["database-1"],
        data_source_ids: ["source-1"],
        view_ids: ["view-1"],
        document_heads: [],
      },
      { kind: "all" },
      { kind: "all" },
    ]);
  });

  test("preserves Core order while admitting a singleton Database row", async () => {
    const ingress = new RendererLocalCommitIngress();
    const messages: ProjectionStreamMessage[] = [];
    ingress.subscribeProjection(scope, (message) => messages.push(message));

    await ingress.admitPacket(
      packet({
        projections: [databaseRowEffect(3)],
      }),
    );

    expect(messages).toEqual([
      expect.objectContaining({
        kind: "effect",
        delivery: expect.objectContaining({
          effect: expect.objectContaining({
            patch: expect.objectContaining({
              kind: "database_row_upsert",
              row: expect.objectContaining({
                id: "page-1",
                status: "ship",
                order: 3,
              }),
            }),
          }),
        }),
      }),
    ]);
  });

  test("deduplicates apply-first and broker-first delivery across packet audiences", async () => {
    const applyFirst = new RendererLocalCommitIngress();
    const applyFirstListener = vi.fn();
    applyFirst.subscribeProjection(scope, applyFirstListener);
    const boundPacket = packet();
    await applyFirst.admitApply(apply(boundPacket));
    await applyFirst.admitPacket(boundPacket);
    expect(applyFirstListener).toHaveBeenCalledTimes(1);

    const brokerFirst = new RendererLocalCommitIngress();
    const brokerFirstListener = vi.fn();
    brokerFirst.subscribeProjection(scope, brokerFirstListener);
    const brokerPacket = packet({
      address: { kind: "library", library_id: "library-1" },
      packetHash: "3".repeat(64),
    });
    await brokerFirst.admitPacket(brokerPacket);
    expect(await brokerFirst.admitApply(apply(boundPacket))).toMatchObject({
      kind: "enriched",
    });
    expect(brokerFirstListener).toHaveBeenCalledTimes(1);
  });

  test("delivers one projection effect independently to Library and Project audiences", async () => {
    const ingress = new RendererLocalCommitIngress();
    const libraryListener = vi.fn();
    const projectListener = vi.fn();
    ingress.subscribeProjection(libraryScope, libraryListener);
    ingress.subscribeProjection(scope, projectListener);
    const brokerPacket = packet({
      address: { kind: "library", library_id: "library-1" },
      packetHash: "3".repeat(64),
    });
    const projectPacket = packet({ packetHash: "4".repeat(64) });

    await ingress.admitPacket(brokerPacket);
    await ingress.admitPacket(projectPacket);
    await ingress.admitPacket(projectPacket);

    expect(libraryListener).toHaveBeenCalledOnce();
    expect(projectListener).toHaveBeenCalledOnce();
  });

  test("admits new resource coverage as enrichment but rejects hash divergence", async () => {
    const ingress = new RendererLocalCommitIngress();
    const listener = vi.fn();
    ingress.subscribeProjection(scope, listener);
    await ingress.admitPacket(packet());

    const secondEffect = {
      ...effect(1),
      scope: {
        schema_version: 1,
        canonical_key: "page:project-1:page-2",
        scope: {
          kind: "page" as const,
          project_id: "project-1",
          page_id: "page-2",
        },
      },
    };
    expect(
      await ingress.admitPacket(
        packet({
          projections: [effect(1), secondEffect],
          packetHash: "4".repeat(64),
        }),
      ),
    ).toMatchObject({ kind: "enriched" });
    expect(listener).toHaveBeenCalledTimes(2);

    await expect(
      ingress.admitPacket(
        packet({
          projections: [effect(1, "f".repeat(64))],
          packetHash: "5".repeat(64),
        }),
      ),
    ).rejects.toThrow("resource identity collision");
  });

  test("keeps semantic atom admission scoped to its delivery audience", async () => {
    const ingress = new RendererLocalCommitIngress();
    const listener = vi.fn();
    ingress.subscribeAtoms(listener);
    const atom: AuthorizedDeliveryPacket["atoms"][number] = {
      descriptor: {
        atom_id: "5".repeat(64),
        atom_order: 0,
        kind: "project_workspace_changed",
        payload_hash: "6".repeat(64),
        required_resources: [{ kind: "library", library_id: "library-1" }],
      },
      payload: {
        module: "project_workspace",
        library_id: "library-1",
        event: {
          kind: "workspace_changed",
          project_catalog_change: null,
          project_ids: [],
          session_ids: [],
          thread_ids: [],
          session_summary_scopes: [],
          session_detail_ids: [],
        },
      },
    };
    const projectA = packet({ projections: [], atoms: [atom] });
    const projectB = packet({
      address: {
        kind: "project",
        library_id: "library-1",
        project_id: "project-2",
      },
      projections: [],
      atoms: [atom],
      packetHash: "7".repeat(64),
    });

    expect(await ingress.admitPacket(projectA)).toMatchObject({ kind: "accepted" });
    expect(await ingress.admitPacket(projectB)).toMatchObject({ kind: "enriched" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("rejects a divergent packet atomically without publishing its valid prefix", async () => {
    const ingress = new RendererLocalCommitIngress();
    const listener = vi.fn();
    ingress.subscribeProjection(scope, listener);
    await ingress.admitPacket(packet());
    listener.mockClear();
    const validNewEffect = {
      ...effect(1),
      scope: {
        schema_version: 1,
        canonical_key: "page:project-1:page-2",
        scope: {
          kind: "page" as const,
          project_id: "project-1",
          page_id: "page-2",
        },
      },
    };

    await expect(
      ingress.admitPacket(
        packet({
          projections: [validNewEffect, effect(1, "f".repeat(64))],
          packetHash: "7".repeat(64),
        }),
      ),
    ).rejects.toThrow("resource identity collision");
    expect(listener).not.toHaveBeenCalled();

    await expect(
      ingress.admitPacket(
        packet({
          projections: [validNewEffect],
          packetHash: "8".repeat(64),
        }),
      ),
    ).resolves.toMatchObject({ kind: "enriched" });
    expect(listener).toHaveBeenCalledOnce();
  });

  test("coalesces concurrent admission through the remembered resource claims", async () => {
    const ingress = new RendererLocalCommitIngress();
    const listener = vi.fn();
    ingress.subscribeProjection(scope, listener);
    const delivery = packet();

    const results = await Promise.all([
      ingress.admitPacket(delivery),
      ingress.admitPacket(delivery),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["accepted", "duplicate"]);
    expect(listener).toHaveBeenCalledOnce();
  });

  test("fails closed at admission capacity instead of dropping semantic work", async () => {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from([1]).buffer),
    );
    const updateHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const document = {
      reference: {
        effect_order: 0,
        page_id: "page-1",
        document_id: "document-1",
        generation: 1,
        base_head_seq: 0,
        result_head_seq: 1,
        update_id: "update-1",
        update_hash: updateHash,
        update_byte_length: 1,
        resource_kind: "document_update" as const,
      },
      inline_update: [1],
    };
    const ingress = new RendererLocalCommitIngress({ maxInFlightAdmissions: 1 });
    const first = ingress.admitPacket(packet({ projections: [], documents: [document] }));
    await expect(
      ingress.admitPacket(
        packet({
          projections: [],
          documents: [document],
          packetHash: "6".repeat(64),
        }),
      ),
    ).rejects.toBeInstanceOf(LocalCommitIngressCapacityError);
    await first;
  });

  test("bounds inline Document verification concurrency for large deliveries", async () => {
    const update = Uint8Array.from([1]);
    const actualDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const digest = new Uint8Array(await actualDigest("SHA-256", update));
    const updateHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const documents = Array.from({ length: 24 }, (_, effectOrder) => ({
      reference: {
        effect_order: effectOrder,
        page_id: `page-${effectOrder}`,
        document_id: `document-${effectOrder}`,
        generation: 1,
        base_head_seq: 0,
        result_head_seq: 1,
        update_id: `update-${effectOrder}`,
        update_hash: updateHash,
        update_byte_length: update.byteLength,
        resource_kind: "document_update" as const,
      },
      inline_update: [...update],
    }));
    let activeDigests = 0;
    let maxActiveDigests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        activeDigests += 1;
        maxActiveDigests = Math.max(maxActiveDigests, activeDigests);
        await gate;
        try {
          return await actualDigest(algorithm, data);
        } finally {
          activeDigests -= 1;
        }
      });
    try {
      const ingress = new RendererLocalCommitIngress();
      const admission = ingress.admitPacket(
        packet({
          projections: [],
          documents,
        }),
      );
      await Promise.resolve();

      expect(digestSpy).toHaveBeenCalledTimes(8);
      expect(maxActiveDigests).toBe(8);

      release();
      await admission;
      expect(digestSpy).toHaveBeenCalledTimes(documents.length);
      expect(maxActiveDigests).toBe(8);
    } finally {
      digestSpy.mockRestore();
    }
  });

  test("isolates downstream listener failures from durable command success", async () => {
    const listenerError = vi.fn();
    const healthy = vi.fn();
    const ingress = new RendererLocalCommitIngress({ onListenerError: listenerError });
    ingress.subscribeProjection(scope, () => {
      throw new Error("consumer failed");
    });
    ingress.subscribeProjection(scope, healthy);

    await expect(ingress.admitApply(apply(packet()))).resolves.toMatchObject({
      kind: "accepted",
    });
    expect(healthy).toHaveBeenCalledOnce();
    expect(listenerError).toHaveBeenCalledOnce();
  });
});
