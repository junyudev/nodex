import { useCallback, useSyncExternalStore } from "react";
import { useCodexAppServerRegistry } from "./local-conversation-store";

/** Metadata consumers observe registered hosts without creating a connection or transcript lease. */
export function useExistingCreatedThreadHost(hostId: string | null) {
  const registry = useCodexAppServerRegistry();
  const subscribeRegistry = useCallback(
    (listener: () => void) => registry.addRegistryCallback(listener),
    [registry],
  );
  const manager = useSyncExternalStore(subscribeRegistry, () =>
    hostId === null ? null : registry.readForHostId(hostId),
  );
  const subscribeConnection = useCallback(
    (listener: () => void) => manager?.observeConnection(listener) ?? (() => {}),
    [manager],
  );
  const connection = useSyncExternalStore(
    subscribeConnection,
    () => manager?.readConnection() ?? null,
  );
  return { manager, connected: connection?.status === "connected" };
}

export function useCreatedThreadSourceAeon(hostId: string | null, threadId: string) {
  const { manager } = useExistingCreatedThreadHost(hostId);
  const subscribe = useCallback(
    (listener: () => void) => manager?.observeThreadMetadata(threadId, listener) ?? (() => {}),
    [manager, threadId],
  );
  return useSyncExternalStore(subscribe, () => {
    const details = manager?.readConversation(threadId)?.canonicalState;
    return (
      details?.threadStartKind === "aeon" ||
      details?.threadSource === "aeon" ||
      details?.mode === "aeon" ||
      manager?.readThreadSummary(threadId)?.threadSource === "aeon"
    );
  });
}
