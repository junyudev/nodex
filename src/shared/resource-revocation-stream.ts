import type { components } from "@nodex/core-protocol";

import type { ProjectionCursor, ProjectionScope } from "./projection-stream";

export interface ResourceRevocation {
  readonly authorization_scope: components["schemas"]["DeliveryAuthorizationScope"];
  readonly resource_kind: Exclude<
    components["schemas"]["ResourceKey"]["kind"],
    "library" | "project"
  >;
  readonly resource_id: string;
  readonly reason: "ownership_moved" | "access_revoked" | "archived" | "deleted";
}

export interface ResourceRevocationDelivery {
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly manifestHash: string;
  readonly operationId: string;
  readonly committedAt: string;
  readonly revocation: ResourceRevocation;
}

/** Immediate authorization-loss delivery. Durable progress remains on the projection stream. */
export interface ResourceRevocationDeliveryMessage {
  readonly version: 1;
  readonly kind: "revocation";
  readonly scope: ProjectionScope;
  readonly stream: ProjectionCursor;
  readonly delivery: ResourceRevocationDelivery;
}

/** Recipient-local transport loss requires a scope repair, not a guessed revoke. */
export interface ResourceRevocationResetMessage {
  readonly version: 1;
  readonly kind: "reset";
  readonly scope: ProjectionScope;
  readonly stream: ProjectionCursor;
  readonly reason: "event_gap" | "reconnect" | "store_epoch_changed" | "recipient_delivery_failed";
}

export type ResourceRevocationMessage =
  | ResourceRevocationDeliveryMessage
  | ResourceRevocationResetMessage;
