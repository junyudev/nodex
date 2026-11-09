import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import type { WindowSessionBootstrap, WindowSessionSaveLayoutInput } from "./types";

const saveWindowSessionLayoutCommand = defineRendererCommand({
  key: "window_session.save_layout",
  channel: "window-sessions:save-layout",
  authority: "main",
  owner: "WindowSessions",
  protocol: { kind: "returned_value" },
});

export async function saveWindowSessionLayout(
  input: WindowSessionSaveLayoutInput,
): Promise<WindowSessionBootstrap> {
  const spaceId = new URL(window.location.href).searchParams.get("spaceId");
  return await invokePlainCommand(saveWindowSessionLayoutCommand, { ...input, spaceId });
}
