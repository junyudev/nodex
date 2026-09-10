import { describe, expect, test } from "vite-plus/test";
import { buildCodexTurnOccurrenceKey } from "./codex-turn-identity";

describe("Codex turn occurrence identity", () => {
  test("keeps an optimistic occurrence stable when the server binds its turn id", () => {
    const entityKey = "turn-local:client-message-1";

    expect(buildCodexTurnOccurrenceKey(null, 0, entityKey)).toBe(entityKey);
    expect(buildCodexTurnOccurrenceKey("turn-server-1", 0, entityKey)).toBe(entityKey);
  });

  test("falls back to the protocol id and then the index", () => {
    expect(buildCodexTurnOccurrenceKey("turn-server-1", 0)).toBe("turn-server-1");
    expect(buildCodexTurnOccurrenceKey(null, 3)).toBe("turn-index-3");
  });
});
