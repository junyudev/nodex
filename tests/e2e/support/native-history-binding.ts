import type { IsolatedProfile } from "../../../scripts/scenarios/profile/isolated-profile";
import { CoreClient } from "../../../src/main/core-client/core-client";
import type { NativeSessionCatalogEntry } from "../../../src/shared/native-session-catalog";
import { createUuidV7 } from "../../../src/shared/uuid-v7";

export interface SeededNativeHistoryBinding {
  readonly sessionId: string;
  readonly threadId: string;
}

/** Seeds an existing native-history binding for readonly presentation tests through Core's typed contract. */
export async function seedNativeHistoryBinding(
  profile: IsolatedProfile,
  nativeHome: string,
  entry: NativeSessionCatalogEntry,
): Promise<SeededNativeHistoryBinding> {
  const client = await CoreClient.connect({
    nodexHome: profile.nodexHome,
    clientKind: "test",
    buildId: "native-history-presentation-fixture",
    requestTimeoutMs: 60_000,
  });
  const result = await client.workspaceApply({
    operationId: createUuidV7(),
    intent: {
      kind: "attach_native_session",
      session_id: createUuidV7(),
      thread_id: entry.nativeSessionId,
      project_id: null,
      backend_binding: { kind: "codex" },
      native_session_id: entry.nativeSessionId,
      native_home: nativeHome,
      title: entry.title,
      cwd: entry.cwd,
      created_at: entry.updatedAt,
      updated_at: entry.updatedAt,
    },
  });
  const [sessionId, ...unexpected] = result.outcome.affected_session_ids;
  if (!sessionId || unexpected.length > 0)
    throw new Error("Native history fixture did not resolve exactly one Session.");
  return { sessionId, threadId: entry.nativeSessionId };
}
