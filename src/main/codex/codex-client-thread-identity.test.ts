import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  codexClientThreadIdentityAtomKey,
  getCodexClientThreadId,
  listCodexClientThreadIdentities,
  resolveCodexThreadIdForClientThreadId,
  setCodexClientThreadIdentity,
  readCodexClientThreadIdentityCandidates,
} from "./codex-client-thread-identity";
import { PersistedAtomStore } from "../local-store/persisted-atoms";

const tempDirectories: string[] = [];

function useTempPersistedAtoms(): PersistedAtomStore {
  const directory = mkdtempSync(join(tmpdir(), "nodex-client-thread-identity-"));
  tempDirectories.push(directory);
  return new PersistedAtomStore(join(directory, "persisted-atoms-v1.json"));
}

describe("Codex client-thread identity", () => {
  test("retains host/native colon ambiguity as candidates and keeps explicit-host lookups exact", () => {
    const store = useTempPersistedAtoms();
    const clientThreadId = "client-new-thread:hosted";
    setCodexClientThreadIdentity(store, {
      hostId: "ssh:owner",
      threadId: "native:thread",
      clientThreadId,
    });
    expect(readCodexClientThreadIdentityCandidates(store, clientThreadId, "ssh:owner")).toEqual([
      { hostId: "ssh:owner", threadId: "native:thread", clientThreadId },
    ]);
    expect(readCodexClientThreadIdentityCandidates(store, clientThreadId)).toEqual([
      { hostId: "ssh", threadId: "owner:native:thread", clientThreadId },
      { hostId: "ssh:owner", threadId: "native:thread", clientThreadId },
      { hostId: "ssh:owner:native", threadId: "thread", clientThreadId },
    ]);
    expect(readCodexClientThreadIdentityCandidates(store, clientThreadId, "foreign")).toEqual([]);
  });
  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists the exact conversation-scoped atom and resolves both directions", () => {
    const store = useTempPersistedAtoms();
    const clientThreadId = "client-new-thread:11111111-1111-4111-8111-111111111111";

    expect(
      setCodexClientThreadIdentity(store, {
        hostId: "local",
        threadId: "conversation with spaces",
        clientThreadId,
      }),
    ).toBe(true);
    expect(codexClientThreadIdentityAtomKey("local", "conversation with spaces")).toBe(
      "thread-client-id-v1:local%3Aconversation%20with%20spaces",
    );
    const replacement = new PersistedAtomStore(
      join(tempDirectories.at(-1)!, "persisted-atoms-v1.json"),
    );
    expect(getCodexClientThreadId(replacement, "local", "conversation with spaces")).toBe(
      clientThreadId,
    );
    expect(resolveCodexThreadIdForClientThreadId(replacement, "local", clientThreadId)).toBe(
      "conversation with spaces",
    );
  });

  test("lists only current conversations and ignores invalid persisted client ids", () => {
    const store = useTempPersistedAtoms();
    setCodexClientThreadIdentity(store, {
      hostId: "local",
      threadId: "current",
      clientThreadId: "client-new-thread:current",
    });
    setCodexClientThreadIdentity(store, {
      hostId: "local",
      threadId: "stale",
      clientThreadId: "client-new-thread:stale",
    });
    store.update({
      key: codexClientThreadIdentityAtomKey("local", "invalid"),
      value: "not-a-client-thread",
    });

    expect(
      JSON.stringify(listCodexClientThreadIdentities(store, "local", ["current", "invalid"])),
    ).toBe(
      '[{"hostId":"local","threadId":"current","clientThreadId":"client-new-thread:current"}]',
    );
    expect(getCodexClientThreadId(store, "local", "invalid")).toBe(null);
  });

  test("rejects blank identities and client ids outside the exact namespace", () => {
    const store = useTempPersistedAtoms();
    expect(
      setCodexClientThreadIdentity(store, {
        hostId: "local",
        threadId: "thread",
        clientThreadId: "thread",
      }),
    ).toBe(false);
    expect(
      setCodexClientThreadIdentity(store, {
        hostId: " ",
        threadId: "thread",
        clientThreadId: "client-new-thread:value",
      }),
    ).toBe(false);
  });
});
