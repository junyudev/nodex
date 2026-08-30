import type { ComputerUseSoundMode } from "../../shared/computer-use-settings";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const removeComputerUseAppApprovalCommand = defineRendererCommand({
  key: "computer_use_settings.remove_app_approval",
  channel: "computer-use-settings-remove-app-approval",
  authority: "main",
  owner: "ComputerUseSettings",
  protocol: { kind: "returned_value" },
});

const removeComputerUseMessageApprovalCommand = defineRendererCommand({
  key: "computer_use_settings.remove_message_approval",
  channel: "computer-use-settings-remove-message-approval",
  authority: "main",
  owner: "ComputerUseSettings",
  protocol: { kind: "returned_value" },
});

const setComputerUseAlwaysHidePipCommand = defineRendererCommand({
  key: "computer_use_settings.set_always_hide_pip",
  channel: "computer-use-settings-set-always-hide-pip",
  authority: "main",
  owner: "ComputerUseSettings",
  protocol: { kind: "returned_value" },
});

const setComputerUseLockedUseCommand = defineRendererCommand({
  key: "computer_use_settings.set_locked_use",
  channel: "computer-use-settings-set-locked-use",
  authority: "main",
  owner: "ComputerUseSettings",
  protocol: { kind: "returned_value" },
});

const setComputerUseSoundModeCommand = defineRendererCommand({
  key: "computer_use_settings.set_sound_mode",
  channel: "computer-use-settings-set-sound-mode",
  authority: "main",
  owner: "ComputerUseSettings",
  protocol: { kind: "returned_value" },
});

export function readComputerUseSettings() {
  return invokeRendererQuery("computer-use-settings-get");
}

export function removeComputerUseAppApproval(bundleIdentifier: string) {
  return invokePlainCommand(removeComputerUseAppApprovalCommand, bundleIdentifier);
}

export function removeComputerUseMessageApproval(chatGuid: string) {
  return invokePlainCommand(removeComputerUseMessageApprovalCommand, chatGuid);
}

export function setComputerUseAlwaysHidePictureInPicture(value: boolean) {
  return invokePlainCommand(setComputerUseAlwaysHidePipCommand, value);
}

export function setComputerUseLockedUse(value: boolean) {
  return invokePlainCommand(setComputerUseLockedUseCommand, value);
}

export function setComputerUseSoundMode(value: ComputerUseSoundMode) {
  return invokePlainCommand(setComputerUseSoundModeCommand, value);
}
