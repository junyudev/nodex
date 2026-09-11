import type { FileSearchEvent, FileSearchStartInput } from "../../shared/file-search";
import type { WorkspaceFileDirectoryEntry } from "../../shared/types";

/** Native-session transport fixture shared by Files workflow tests and pressure stories. */
export function createFileSearchFixture(entries: readonly WorkspaceFileDirectoryEntry[]) {
  const listeners = new Set<(event: FileSearchEvent) => void>();
  const sessions = new Map<string, FileSearchStartInput>();
  const emit = (event: FileSearchEvent) => listeners.forEach((listener) => listener(event));
  return {
    invoke(channel: string, value: unknown) {
      const input = value as FileSearchStartInput & { query: string };
      if (channel === "file-search:start") sessions.set(input.sessionId, input);
      if (channel === "file-search:stop") sessions.delete(input.sessionId);
      if (channel !== "file-search:update") return;
      const session = sessions.get(input.sessionId);
      if (!session) throw new Error("File search session not found");
      emit({
        method: "fuzzyFileSearch/sessionUpdated",
        params: {
          sessionId: input.sessionId,
          query: input.query,
          files: entries
            .filter((entry) => entry.path.toLowerCase().includes(input.query.toLowerCase()))
            .map((entry) => ({
              root: session.roots[0]!,
              path: entry.path,
              file_name: entry.name,
              match_type: entry.type,
              score: 10,
              indices: null,
            })),
        },
      });
      emit({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: input.sessionId } });
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      if (channel !== "file-search:event") return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
