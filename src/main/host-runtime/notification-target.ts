import type { CodexRendererPresentationRegistryService } from "../codex-application/CodexRendererPresentationRegistry";
import type { RendererClientRuntime } from "./RendererClientRuntime";
import type { WindowRuntime } from "../window-runtime/WindowRuntime";

/** Shared desktop target order: latest presentation, last focused window, first live window. */
export const resolveNotificationTargetClient = (
  conversationId: string,
  presentation: Pick<CodexRendererPresentationRegistryService, "resolvePresentedSurfaceClient">,
  windows: Pick<WindowRuntime["Service"], "getLastFocused">,
  clients: Pick<RendererClientRuntime["Service"], "getClientIdForWebContentsId">,
): string | null => {
  const presenting = presentation.resolvePresentedSurfaceClient(conversationId);
  if (presenting) return presenting;
  const fallback = windows.getLastFocused();
  return fallback ? clients.getClientIdForWebContentsId(fallback.webContents.id) : null;
};
