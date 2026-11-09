import type { components } from "@nodex/core-protocol";

/** Core owns Profile listener intent and live routes for every local administration surface. */
export type RemoteAccessIntent = components["schemas"]["RemoteAccessState"]["intent"];

export interface SpaceRemoteAccessSnapshot {
  readonly listener: components["schemas"]["ListenerInfo"] | null;
  /** Null for a remote Space: only its host can configure listener lifetime. */
  readonly intent: RemoteAccessIntent | null;
  readonly routesChanged: boolean;
}

export interface SpaceAdministrationIpcApi {
  "space-admin:members": { args: []; result: readonly components["schemas"]["Member"][] };
  "space-admin:devices": { args: []; result: readonly components["schemas"]["MemberDevice"][] };
  "space-admin:invite": {
    args: [input: components["schemas"]["InviteRequest"]];
    result: components["schemas"]["InviteResponse"];
  };
  "space-admin:link-device": { args: []; result: components["schemas"]["DeviceLinkOffer"] };
  "space-admin:revoke": {
    args: [input: components["schemas"]["RevokeDeviceRequest"]];
    result: boolean;
  };
  "space-admin:remove-member": {
    args: [input: components["schemas"]["RemoveMemberRequest"]];
    result: boolean;
  };
  "space-admin:name": {
    args: [input: components["schemas"]["RenameSpaceRequest"]];
    result: components["schemas"]["SpaceName"];
  };
  "space-admin:member-name": {
    args: [input: components["schemas"]["RenameMemberRequest"]];
    result: components["schemas"]["Member"];
  };
  "space-admin:remote-access": { args: []; result: SpaceRemoteAccessSnapshot };
  "space-admin:remote-access-on": {
    args: [input: { readonly address: string }];
    result: SpaceRemoteAccessSnapshot;
  };
  "space-admin:remote-access-off": { args: []; result: SpaceRemoteAccessSnapshot };
}
