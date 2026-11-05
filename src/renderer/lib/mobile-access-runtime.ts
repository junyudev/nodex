import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const mobileAccessCommand = <
  const Key extends string,
  const Channel extends Parameters<typeof invokePlainCommand>[0]["channel"],
>(
  key: Key,
  channel: Channel,
) =>
  defineRendererCommand({
    key,
    channel,
    authority: "main",
    owner: "Settings",
    protocol: { kind: "pending_operation" },
  });

const setEnabledCommand = mobileAccessCommand(
  "mobile-access.set-enabled",
  "mobile-access:set-enabled",
);
const beginPairingCommand = mobileAccessCommand(
  "mobile-access.begin-pairing",
  "mobile-access:begin-pairing",
);
const cancelPairingCommand = mobileAccessCommand(
  "mobile-access.cancel-pairing",
  "mobile-access:cancel-pairing",
);
const revokeDeviceCommand = mobileAccessCommand(
  "mobile-access.revoke-device",
  "mobile-access:revoke-device",
);

export const readMobileAccessStatus = () => invokeRendererQuery("mobile-access:status");
export const setMobileAccessEnabled = (enabled: boolean) =>
  invokePlainCommand(setEnabledCommand, { enabled });
export const beginMobilePairing = () => invokePlainCommand(beginPairingCommand);
export const cancelMobilePairing = () => invokePlainCommand(cancelPairingCommand);
export const revokeMobileDevice = (deviceId: string) =>
  invokePlainCommand(revokeDeviceCommand, { deviceId });
