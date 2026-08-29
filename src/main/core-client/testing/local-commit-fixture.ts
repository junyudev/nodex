import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";

import type { CoreAuthorizedDeliveryPacket, CoreModuleEventPayload } from "../types";
import type { ResourceRevocation } from "../../../shared/resource-revocation-stream";

interface CoreLocalCommitFixtureInput {
  readonly commitSeq: number;
  readonly payload?: CoreModuleEventPayload;
  readonly additionalPayloads?: readonly CoreModuleEventPayload[];
  readonly documentEffects?: CoreAuthorizedDeliveryPacket["document_effects"];
  readonly projectionEffects?: CoreAuthorizedDeliveryPacket["projection_effects"];
  readonly revocations?: readonly ResourceRevocation[];
  readonly visibilityDeltas?: CoreAuthorizedDeliveryPacket["visibility_deltas"];
  readonly authorizationScope?: CoreAuthorizedDeliveryPacket["authorization_scope"];
  readonly canonicalHash?: string;
  readonly storeEpoch?: string;
  readonly operationId?: string;
  readonly committedAt?: string;
  readonly requiredResources?: CoreAuthorizedDeliveryPacket["atoms"][number]["descriptor"]["required_resources"];
}

const atomKind = (
  payload: CoreModuleEventPayload,
): CoreAuthorizedDeliveryPacket["atoms"][number]["descriptor"]["kind"] => {
  switch (payload.module) {
    case "library":
      return "library_navigation_changed";
    case "database":
      return "database_changed";
    case "owned_document":
      return "owned_document_changed";
    case "project_workspace":
      return "project_workspace_changed";
    case "automation":
      return "automation_changed";
    case "store_administration":
      return "store_administration_changed";
  }
};

export const createCoreLocalCommitFixture = (
  input: CoreLocalCommitFixtureInput,
): CoreAuthorizedDeliveryPacket => {
  const storeEpoch = input.storeEpoch ?? "epoch-1";
  const operationId = input.operationId ?? `operation-${input.commitSeq}`;
  const committedAt = input.committedAt ?? "2026-08-06T00:00:00.000Z";
  const payloads = [
    ...(input.payload === undefined ? [] : [input.payload]),
    ...(input.additionalPayloads ?? []),
  ];
  const manifestHash = input.canonicalHash ?? String(input.commitSeq).padStart(64, "0").slice(-64);
  const documentEffects = input.documentEffects ?? [];
  const projectionEffects = input.projectionEffects ?? [];
  const authorizationScope = input.authorizationScope ?? {
    kind: "library" as const,
    library_id: "library-1",
  };
  const visibilityDeltas =
    input.visibilityDeltas ??
    (input.revocations ?? []).map(
      (revocation, index): CoreAuthorizedDeliveryPacket["visibility_deltas"][number] => ({
        authorization_scope: revocation.authorization_scope,
        change: {
          kind: "revoke",
          reason: revocation.reason,
        },
        roots: [
          {
            kind: revocation.resource_kind,
            [`${revocation.resource_kind}_id`]: revocation.resource_id,
          } as CoreAuthorizedDeliveryPacket["visibility_deltas"][number]["roots"][number],
        ],
        delta_hash: String(input.commitSeq * 100 + index)
          .padStart(64, "5")
          .slice(-64),
      }),
    );
  const atoms = payloads.map((payload, atomOrder) => ({
    descriptor: {
      atom_id: String(input.commitSeq * 100 + atomOrder)
        .padStart(64, "3")
        .slice(-64),
      atom_order: atomOrder,
      kind: atomKind(payload),
      payload_hash: String(input.commitSeq * 10 + atomOrder)
        .padStart(64, "2")
        .slice(-64),
      required_resources: input.requiredResources ?? [
        {
          kind: "library" as const,
          library_id: payload.library_id,
        },
      ],
    },
    payload,
  }));
  return {
    packet_version: 4,
    delivery_address: authorizationScope,
    authorization_scope: authorizationScope,
    manifest: {
      event_version: CORE_CLIENT_REQUIREMENTS.event_version,
      identity: {
        commit_seq: input.commitSeq,
        manifest_hash: manifestHash,
        store_epoch: storeEpoch,
      },
      operation_id: operationId,
      committed_at: committedAt,
    },
    atoms,
    document_effects: documentEffects,
    projection_effects: projectionEffects,
    visibility_deltas: visibilityDeltas,
    coverage: {
      atom_ids: atoms.map((atom) => atom.descriptor.atom_id),
      document_effect_orders: documentEffects.map((effect) => effect.reference.effect_order),
      inline_document_effect_orders: documentEffects
        .filter((effect) => effect.inline_update !== null && effect.inline_update !== undefined)
        .map((effect) => effect.reference.effect_order),
      projection_scope_keys: projectionEffects.map((effect) => effect.scope.canonical_key),
    },
    packet_hash: String(input.commitSeq).padStart(64, "4").slice(-64),
  };
};
