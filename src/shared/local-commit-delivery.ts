import type { components } from "@nodex/core-protocol";

import {
  parseAuthorizedDeliveryPacket,
  type AuthorizedDeliveryPacket,
} from "./authorized-delivery-packet";
import { projectCoreDatabaseRowSummary } from "./database-page-projection";
import type {
  CoreProjectionEffect,
  ProjectionDelivery,
  ProjectionEffect,
  ProjectionPatch,
  ProjectionScope,
  ProjectionStreamMessage,
} from "./projection-stream";
import type {
  ResourceRevocation,
  ResourceRevocationDelivery,
  ResourceRevocationDeliveryMessage,
} from "./resource-revocation-stream";

export type { AuthorizedDeliveryPacket } from "./authorized-delivery-packet";

export type LocalCommitApply =
  | {
      readonly status: "committed";
      readonly commit: components["schemas"]["CommitIdentity"];
      readonly delivery: AuthorizedDeliveryPacket | null;
    }
  | {
      readonly status: "no_op";
      readonly observed: components["schemas"]["StoreObservation"];
    };

export interface LocalCommitCommandSuccess<Value> {
  readonly ok: true;
  readonly value: Value;
  readonly localCommit: LocalCommitApply;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export const revocationsFromVisibilityDelta = (
  delta: AuthorizedDeliveryPacket["visibility_deltas"][number],
): readonly ResourceRevocation[] => {
  if (delta.change.kind !== "revoke") return [];
  const reason = delta.change.reason;
  return delta.roots.flatMap((root): readonly ResourceRevocation[] => {
    const identity =
      root.kind === "page"
        ? root.page_id
        : root.kind === "document"
          ? root.document_id
          : root.kind === "database"
            ? root.database_id
            : root.kind === "data_source"
              ? root.data_source_id
              : root.kind === "view"
                ? root.view_id
                : root.kind === "canvas"
                  ? root.canvas_id
                  : root.kind === "file"
                    ? root.file_id
                    : null;
    if (identity === null || root.kind === "library" || root.kind === "project") {
      return [];
    }
    return [
      {
        authorization_scope: delta.authorization_scope,
        resource_kind: root.kind,
        resource_id: identity,
        reason,
      },
    ];
  });
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validIdentity = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.store_epoch === "string" &&
  value.store_epoch.length > 0 &&
  value.store_epoch === value.store_epoch.trim() &&
  Number.isSafeInteger(value.commit_seq) &&
  Number(value.commit_seq) > 0 &&
  typeof value.manifest_hash === "string" &&
  HASH_PATTERN.test(value.manifest_hash);

const validObservation = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.store_epoch === "string" &&
  value.store_epoch.length > 0 &&
  value.store_epoch === value.store_epoch.trim() &&
  Number.isSafeInteger(value.commit_head) &&
  Number(value.commit_head) >= 0;

/** Strictly parses the transport-neutral part of a Core ApplyResponse. */
export const parseLocalCommitApply = (value: unknown): LocalCommitApply => {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new TypeError("Local commit apply result is invalid");
  }
  if (value.status === "no_op") {
    if (!validObservation(value.observed)) {
      throw new TypeError("Local commit observation is invalid");
    }
    return {
      status: "no_op",
      observed: value.observed as components["schemas"]["StoreObservation"],
    };
  }
  if (value.status !== "committed" || !validIdentity(value.commit)) {
    throw new TypeError("Local commit identity is invalid");
  }
  if (value.delivery !== null && value.delivery !== undefined) {
    parseAuthorizedDeliveryPacket(value.delivery);
  }
  return {
    status: "committed",
    commit: value.commit as components["schemas"]["CommitIdentity"],
    delivery: (value.delivery ?? null) as AuthorizedDeliveryPacket | null,
  };
};

const projectIdOf = (effect: CoreProjectionEffect): string | null => {
  const scope = effect.scope.scope;
  return scope.kind === "library" ? null : scope.project_id;
};

export const projectionScopeCanReceive = (
  subscription: ProjectionScope,
  effect: CoreProjectionEffect,
): boolean => {
  if (subscription.kind === "library") return true;
  return projectIdOf(effect) === subscription.projectId;
};

const mapPatch = (patch: CoreProjectionEffect["patch"]): ProjectionPatch | null => {
  if (!patch) return null;
  if (patch.kind === "page_changed") {
    return {
      kind: patch.kind,
      projectId: patch.project_id,
      pageId: patch.page_id,
    };
  }
  if (patch.kind === "database_row_remove") {
    return {
      kind: patch.kind,
      projectId: patch.project_id,
      databaseId: patch.database_id,
      dataSourceId: patch.data_source_id,
      viewId: patch.view_id,
      pageId: patch.page_id,
      totalRows: patch.total_rows,
      groupKey: patch.group_key ?? null,
      subgroupKey: patch.subgroup_key ?? null,
      groupTotal: patch.group_total ?? null,
    };
  }
  const row = projectCoreDatabaseRowSummary(patch.row);
  return {
    kind: patch.kind,
    projectId: patch.project_id,
    databaseId: patch.database_id,
    dataSourceId: patch.data_source_id,
    viewId: patch.view_id,
    row,
    sourceRow: patch.row,
    effectiveGroupKey: patch.row.effective_group_key ?? null,
    effectiveSubgroupKey: patch.row.effective_subgroup_key ?? null,
    rankKey: patch.row.rank_key ?? null,
    totalRows: patch.total_rows,
    groupTotal: patch.group_total ?? null,
  };
};

const mapEffect = (effect: CoreProjectionEffect): ProjectionEffect => ({
  scope: effect.scope,
  baseRevision: effect.base_revision,
  resultRevision: effect.result_revision,
  coveredCommitSeq: effect.covered_commit_seq,
  patch: mapPatch(effect.patch),
  requiresReadAtLeast: effect.requires_read_at_least,
  effectHash: effect.effect_hash,
});

const projectionImpactOf = (effect: CoreProjectionEffect): ProjectionDelivery["impact"] => {
  const patch = effect.patch;
  if (!patch) {
    const scope = effect.scope.scope;
    if (scope.kind === "structural_history") {
      return { kind: "none" };
    }
    if (scope.kind === "page") {
      return {
        kind: "resources",
        page_ids: [scope.page_id],
        database_ids: [],
        data_source_ids: [],
        view_ids: [],
        document_heads: [],
      };
    }
    if (scope.kind === "database_view") {
      return {
        kind: "resources",
        page_ids: [],
        database_ids: [scope.database_id],
        data_source_ids: [scope.data_source_id],
        view_ids: [scope.view_id],
        document_heads: [],
      };
    }
    if (scope.kind === "page_detail_data_source") {
      return {
        kind: "resources",
        page_ids: [],
        database_ids: [scope.database_id],
        data_source_ids: [scope.data_source_id],
        view_ids: [],
        document_heads: [],
      };
    }
    if (scope.kind === "page_detail_database") {
      return {
        kind: "resources",
        page_ids: [],
        database_ids: [scope.database_id],
        data_source_ids: [],
        view_ids: [],
        document_heads: [],
      };
    }
    return { kind: "all" };
  }
  if (patch.kind === "page_changed") {
    return {
      kind: "resources",
      page_ids: [patch.page_id],
      database_ids: [],
      data_source_ids: [],
      view_ids: [],
      document_heads: [],
    };
  }
  return {
    kind: "resources",
    page_ids: [patch.kind === "database_row_remove" ? patch.page_id : patch.row.page_id],
    database_ids: [patch.database_id],
    data_source_ids: [patch.data_source_id],
    view_ids: [patch.view_id],
    document_heads: [],
  };
};

export const projectionMessageFromDelivery = (
  packet: AuthorizedDeliveryPacket,
  effect: CoreProjectionEffect,
  scope: ProjectionScope,
): ProjectionStreamMessage => ({
  version: 2,
  kind: "effect",
  scope,
  stream: {
    storeEpoch: packet.manifest.identity.store_epoch,
    commitSeq: packet.manifest.identity.commit_seq,
  },
  delivery: {
    storeEpoch: packet.manifest.identity.store_epoch,
    commitSeq: packet.manifest.identity.commit_seq,
    manifestHash: packet.manifest.identity.manifest_hash,
    operationId: packet.manifest.operation_id,
    committedAt: packet.manifest.committed_at,
    impact: projectionImpactOf(effect),
    effect: mapEffect(effect),
  },
});

export const revocationScopeCanReceive = (
  subscription: ProjectionScope,
  revocation: ResourceRevocation,
): boolean => {
  const authorization = revocation.authorization_scope;
  if (authorization.library_id !== subscription.libraryId) return false;
  if (authorization.kind === "library") return subscription.kind === "library";
  if (authorization.kind === "document") return false;
  return subscription.kind === "project" && subscription.projectId === authorization.project_id;
};

export const revocationMessageFromDelivery = (
  packet: AuthorizedDeliveryPacket,
  revocation: ResourceRevocation,
  scope: ProjectionScope,
): ResourceRevocationDeliveryMessage => {
  const delivery: ResourceRevocationDelivery = {
    storeEpoch: packet.manifest.identity.store_epoch,
    commitSeq: packet.manifest.identity.commit_seq,
    manifestHash: packet.manifest.identity.manifest_hash,
    operationId: packet.manifest.operation_id,
    committedAt: packet.manifest.committed_at,
    revocation,
  };
  return {
    version: 1,
    kind: "revocation",
    scope,
    stream: {
      storeEpoch: packet.manifest.identity.store_epoch,
      commitSeq: packet.manifest.identity.commit_seq,
    },
    delivery,
  };
};
