import { defineRendererCommand, invokePlainCommand } from "./renderer-command";

const toggleAvatarOverlayCommand = defineRendererCommand({
  authority: "main",
  channel: "avatar-overlay:toggle",
  key: "avatar-overlay-toggle",
  owner: "avatar-overlay-runtime",
  protocol: { kind: "returned_value" },
});

export async function toggleAvatarOverlay(): Promise<boolean> {
  return await invokePlainCommand(toggleAvatarOverlayCommand);
}
