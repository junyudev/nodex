import { scopedAtom, useScopeHandle } from "@/lib/maitai";
import { RouteScope } from "@/lib/workbench-ui-scopes";
import { useCallback, useLayoutEffect } from "react";
import type { McpAppFollowUpMessage } from "@/lib/mcp-app/mcp-app-follow-up";

type SendPluginAppMessage = (message: McpAppFollowUpMessage, sourceId: string) => Promise<void>;

const followUpAtom = scopedAtom<{
  readonly sessionId: string;
  readonly send: SendPluginAppMessage;
} | null>(RouteScope, null, { debugLabel: "plugin-app-follow-up" });

export function useRegisterPluginAppFollowUp(
  sessionId: string | null | undefined,
  send: SendPluginAppMessage,
) {
  const route = useScopeHandle(RouteScope);
  useLayoutEffect(() => {
    if (!sessionId) return;
    const recipient = { sessionId, send };
    route.set(followUpAtom, recipient);
    return () => route.set(followUpAtom, (current) => (current === recipient ? null : current));
  }, [route, send, sessionId]);
}

export function useReadPluginAppFollowUp() {
  const route = useScopeHandle(RouteScope);
  return useCallback(
    (sessionId: string) => {
      const recipient = route.get(followUpAtom);
      return recipient?.sessionId === sessionId ? recipient : null;
    },
    [route],
  );
}
