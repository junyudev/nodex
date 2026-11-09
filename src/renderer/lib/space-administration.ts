import { encodeDeviceLink } from "@nodex/mobile-protocol";
import type { components } from "@nodex/core-protocol";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

export const members = () => invokeRendererQuery("space-admin:members");
export const devices = () => invokeRendererQuery("space-admin:devices");
const inviteCommand = defineRendererCommand({
  key: "space-admin.invite",
  channel: "space-admin:invite",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const invite = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:invite"]["args"]
) => invokePlainCommand(inviteCommand, ...args);
const linkDeviceCommand = defineRendererCommand({
  key: "space-admin.link-device",
  channel: "space-admin:link-device",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const linkDevice = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:link-device"]["args"]
) => invokePlainCommand(linkDeviceCommand, ...args);
const revokeDeviceCommand = defineRendererCommand({
  key: "space-admin.revoke",
  channel: "space-admin:revoke",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const revokeDevice = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:revoke"]["args"]
) => invokePlainCommand(revokeDeviceCommand, ...args);
const removeMemberCommand = defineRendererCommand({
  key: "space-admin.remove-member",
  channel: "space-admin:remove-member",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const removeMember = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:remove-member"]["args"]
) => invokePlainCommand(removeMemberCommand, ...args);
const renameCommand = defineRendererCommand({
  key: "space-admin.name",
  channel: "space-admin:name",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const rename = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:name"]["args"]
) => invokePlainCommand(renameCommand, ...args);
const renameMemberCommand = defineRendererCommand({
  key: "space-admin.member-name",
  channel: "space-admin:member-name",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const renameMember = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:member-name"]["args"]
) => invokePlainCommand(renameMemberCommand, ...args);
export const remoteAccess = () => invokeRendererQuery("space-admin:remote-access");
const remoteAccessOnCommand = defineRendererCommand({
  key: "space-admin.remote-access-on",
  channel: "space-admin:remote-access-on",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const remoteAccessOn = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:remote-access-on"]["args"]
) => invokePlainCommand(remoteAccessOnCommand, ...args);
const remoteAccessOffCommand = defineRendererCommand({
  key: "space-admin.remote-access-off",
  channel: "space-admin:remote-access-off",
  authority: "main",
  owner: "SpaceAdministration",
  protocol: { kind: "returned_value" },
});
export const remoteAccessOff = (
  ...args: import("../../shared/ipc-api").IpcApi["space-admin:remote-access-off"]["args"]
) => invokePlainCommand(remoteAccessOffCommand, ...args);

/** One canonical phone link encoding for QR codes and copied links. */
export const deviceLinkUri = (offer: components["schemas"]["DeviceLinkOffer"]): string =>
  encodeDeviceLink({ ...offer, routes: [...offer.routes] });
