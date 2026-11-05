import { inboxScopeKey, type InboxScope } from "@nodex/mobile-protocol";
import { useCallback, useEffect, useMemo } from "react";
import { useAtomValue } from "@effect/atom-react/Hooks";
import { getRuntime } from "./instance";
import type { ChatListInput, InboxRow } from "./lists";

export function useConnection() {
  return useAtomValue(getRuntime().connection.state.atom);
}

export function useHosts() {
  return useAtomValue(getRuntime().connection.hosts.atom);
}

function useHostId() {
  return useAtomValue(getRuntime().connection.hosts.atom, (state) => state.activeHostId);
}

export function useProjects() {
  const { projects, projectReads } = getRuntime().lists;
  useEffect(() => projectReads.attach(), [projectReads]);
  return useAtomValue(projects.atom);
}

export function useAgentCatalog() {
  const { agents, agentReads } = getRuntime().lists;
  useEffect(() => agentReads.attach(), [agentReads]);
  return useAtomValue(agents.atom);
}

export function useNewChatPreferences() {
  const hostId = useHostId();
  const value = useAtomValue(getRuntime().getPreferences(hostId).atom);
  const set = useCallback(
    (patch: Partial<typeof value>) => getRuntime().setPreferences(hostId, patch),
    [hostId],
  );
  return { ...value, set };
}

const rows = new WeakMap<object, InboxRow>();
function reuseRow<T extends InboxRow>(item: object, build: () => T) {
  const previous = rows.get(item);
  if (previous) return previous;
  const next = build();
  rows.set(item, next);
  return next;
}

export function useInbox(scope: InboxScope, filter: "inbox" | "processed") {
  const { lists, outbox } = getRuntime();
  const hostId = useHostId();
  const list = lists.inbox(hostId, scope, filter);
  useEffect(() => list.attach(), [list]);
  const { items, ...view } = useAtomValue(list.store.atom);
  const pageIds = useMemo(() => new Set(items.map((item) => item.pageId)), [items]);
  const captures = useAtomValue(outbox.store.atom);
  const pending = useMemo(
    () =>
      filter === "inbox"
        ? captures
            .filter(
              (entry) =>
                entry.hostId === hostId &&
                inboxScopeKey(entry.capture.scope) === inboxScopeKey(scope) &&
                !pageIds.has(entry.pageId),
            )
            .map((entry) => entry.capture)
        : [],
    [captures, filter, hostId, scope, pageIds],
  );
  const inboxRows = useMemo(
    () => [
      ...items.map((message) => reuseRow(message, () => ({ type: "message", message }))),
      ...pending.map((capture) => reuseRow(capture, () => ({ type: "pending", capture }))),
    ],
    [items, pending],
  );
  return { ...view, rows: inboxRows, loadMore: list.loadMore, refresh: list.refresh };
}

export function useChats(input: ChatListInput) {
  const hostId = useHostId();
  const list = getRuntime().lists.chats(hostId, input);
  useEffect(() => list.attach(), [list]);
  return { ...useAtomValue(list.store.atom), loadMore: list.loadMore, refresh: list.refresh };
}

export function useChat(sessionId: string) {
  const hostId = useHostId();
  const session = getRuntime().chats.get(hostId, sessionId);
  useEffect(() => session.attach(), [session]);
  return {
    ...useAtomValue(session.store.atom),
    loadOlder: session.loadOlder,
    send: session.send,
    stop: session.stop,
    respond: session.respond,
  };
}

export function useFileUri(ref: string | null) {
  const hostId = useHostId();
  const file = getRuntime().files.get(hostId, ref);
  useEffect(() => file.attach(), [file]);
  return useAtomValue(file.store.atom);
}
