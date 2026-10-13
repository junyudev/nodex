import { isCodexClientThreadId } from "../../shared/codex-client-thread";
import type { PersistedAtomStore } from "../local-store/persisted-atoms";

const CODEX_CLIENT_THREAD_ID_ATOM_PREFIX = "thread-client-id-v1:";

export interface CodexClientThreadIdentity {
  readonly hostId: string;
  readonly threadId: string;
  readonly clientThreadId: string;
}

export function codexClientThreadIdentityAtomKey(hostId: string, threadId: string): string {
  return `${CODEX_CLIENT_THREAD_ID_ATOM_PREFIX}${encodeURIComponent(`${hostId}:${threadId}`)}`;
}

export function setCodexClientThreadIdentity(
  store: PersistedAtomStore,
  identity: CodexClientThreadIdentity,
): boolean {
  const hostId = identity.hostId.trim();
  const threadId = identity.threadId.trim();
  const clientThreadId = identity.clientThreadId.trim();
  if (!hostId || !threadId || !isCodexClientThreadId(clientThreadId)) return false;

  store.update({
    key: codexClientThreadIdentityAtomKey(hostId, threadId),
    value: clientThreadId,
  });
  return true;
}

export function getCodexClientThreadId(
  store: PersistedAtomStore,
  hostId: string,
  threadId: string,
): string | null {
  const value = store.readState()[codexClientThreadIdentityAtomKey(hostId, threadId)];
  return isCodexClientThreadId(value) ? value : null;
}

export function listCodexClientThreadIdentities(
  store: PersistedAtomStore,
  hostId: string,
  threadIds: readonly string[],
): CodexClientThreadIdentity[] {
  const state = store.readState();
  return threadIds.flatMap((threadId) => {
    const clientThreadId = state[codexClientThreadIdentityAtomKey(hostId, threadId)];
    return isCodexClientThreadId(clientThreadId) ? [{ hostId, threadId, clientThreadId }] : [];
  });
}

export function resolveCodexThreadIdForClientThreadId(
  store: PersistedAtomStore,
  hostId: string,
  clientThreadId: string,
): string | null {
  if (!isCodexClientThreadId(clientThreadId)) return null;
  const identityPrefix = `${hostId}:`;
  for (const [key, value] of Object.entries(store.readState())) {
    if (value !== clientThreadId || !key.startsWith(CODEX_CLIENT_THREAD_ID_ATOM_PREFIX)) continue;
    try {
      const identity = decodeURIComponent(key.slice(CODEX_CLIENT_THREAD_ID_ATOM_PREFIX.length));
      if (!identity.startsWith(identityPrefix)) continue;
      const threadId = identity.slice(identityPrefix.length);
      if (threadId) return threadId;
    } catch {
      // Ignore malformed persisted keys; exact lookups remain usable.
    }
  }
  return null;
}

/** Candidates carry only persisted coordinates; Core still confirms their live host binding. */
export function readCodexClientThreadIdentityCandidates(
  store: PersistedAtomStore,
  clientThreadId: string,
  expectedHostId?: string,
): readonly CodexClientThreadIdentity[] {
  if (!isCodexClientThreadId(clientThreadId)) return [];
  const candidates: CodexClientThreadIdentity[] = [];
  for (const [key, value] of Object.entries(store.readState())) {
    if (value !== clientThreadId || !key.startsWith(CODEX_CLIENT_THREAD_ID_ATOM_PREFIX)) continue;
    let coordinate: string;
    try {
      coordinate = decodeURIComponent(key.slice(CODEX_CLIENT_THREAD_ID_ATOM_PREFIX.length));
    } catch {
      continue;
    }
    if (expectedHostId !== undefined) {
      const prefix = `${expectedHostId}:`;
      if (coordinate.startsWith(prefix) && coordinate.length > prefix.length)
        candidates.push({
          hostId: expectedHostId,
          threadId: coordinate.slice(prefix.length),
          clientThreadId,
        });
      continue;
    }
    // The persisted key predates structured coordinates. Do not guess which colon belongs
    // to a host/native id: the caller admits only the unique Core-confirmed candidate.
    for (
      let index = coordinate.indexOf(":");
      index >= 0;
      index = coordinate.indexOf(":", index + 1)
    ) {
      if (index === 0 || index === coordinate.length - 1) continue;
      candidates.push({
        hostId: coordinate.slice(0, index),
        threadId: coordinate.slice(index + 1),
        clientThreadId,
      });
    }
  }
  return candidates;
}
