import type { components } from "@nodex/core-protocol";

import type { AuthorizedDeliveryPacket } from "./authorized-delivery-packet";
import type { ProjectionCursor, ProjectionScope } from "./projection-stream";

export const RECIPIENT_DELIVERY_VERSION = 4 as const;

export type DeliveryAddress = components["schemas"]["DeliveryAddress"];
export type AuthorizedRecipientLease = components["schemas"]["AuthorizedRecipientLease"];
export type AddressReset = components["schemas"]["AddressReset"];
export type AddressResetReason = components["schemas"]["AddressResetReason"];

export const deliveryAddressKey = (address: DeliveryAddress): string => JSON.stringify(address);

export const projectionScopeDeliveryAddress = (scope: ProjectionScope): DeliveryAddress =>
  scope.kind === "library"
    ? { kind: "library", library_id: scope.libraryId }
    : {
        kind: "project",
        library_id: scope.libraryId,
        project_id: scope.projectId,
      };

export const deliveryAddressProjectionScope = (address: DeliveryAddress): ProjectionScope | null =>
  address.kind === "library"
    ? { kind: "library", libraryId: address.library_id }
    : address.kind === "project"
      ? {
          kind: "project",
          libraryId: address.library_id,
          projectId: address.project_id,
        }
      : null;

export type RecipientDeliveryPayload =
  | {
      readonly kind: "checkpoint";
      readonly stream: ProjectionCursor;
    }
  | {
      readonly kind: "packet";
      readonly packet: AuthorizedDeliveryPacket;
    }
  | {
      readonly kind: "reset";
      readonly reset: AddressReset;
    };

export interface RecipientDeliveryEnvelope {
  readonly version: typeof RECIPIENT_DELIVERY_VERSION;
  readonly deliveryId: string;
  readonly recipientLeaseId: string;
  readonly deliveryAddress: DeliveryAddress;
  readonly payload: RecipientDeliveryPayload;
}

export type RecipientAdmissionResult =
  | {
      readonly version: typeof RECIPIENT_DELIVERY_VERSION;
      readonly deliveryId: string;
      readonly outcome: "ack";
    }
  | {
      readonly version: typeof RECIPIENT_DELIVERY_VERSION;
      readonly deliveryId: string;
      readonly outcome: "nack";
      readonly reason: "capacity" | "causal_divergence" | "invalid_message";
    };
