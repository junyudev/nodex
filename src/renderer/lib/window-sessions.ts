import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import type {
  WindowSessionBootstrap,
  WindowSessionBounds,
  WindowSessionSaveLayoutInput,
} from "./types";

const saveWindowSessionLayoutCommand = defineRendererCommand({
  key: "window_session.save_layout",
  channel: "window-sessions:save-layout",
  authority: "main",
  owner: "WindowSessions",
  protocol: { kind: "returned_value" },
});

const updateWindowSessionBoundsCommand = defineRendererCommand({
  key: "window_session.update_bounds",
  channel: "window-sessions:update-bounds",
  authority: "main",
  owner: "WindowSessions",
  protocol: { kind: "pending_operation" },
});

export async function bootstrapWindowSession(): Promise<WindowSessionBootstrap> {
  return await invokeRendererQuery("window-sessions:bootstrap");
}

export async function saveWindowSessionLayout(
  input: WindowSessionSaveLayoutInput,
): Promise<WindowSessionBootstrap> {
  return await invokePlainCommand(saveWindowSessionLayoutCommand, input);
}

export async function updateWindowSessionBounds(bounds: WindowSessionBounds): Promise<void> {
  await invokePlainCommand(updateWindowSessionBoundsCommand, bounds);
}
