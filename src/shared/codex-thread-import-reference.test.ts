import { describe, expect, it } from "vite-plus/test";
import { parseCodexThreadImportReference } from "./codex-thread-import-reference";

const THREAD_ID = "019abcde-1234-7000-8000-123456789abc";

describe("Codex thread import references", () => {
  it.each([
    THREAD_ID,
    ` ${THREAD_ID.toUpperCase()}\n`,
    `codex://threads/${THREAD_ID}`,
    `codex://threads/${THREAD_ID.toUpperCase()}/`,
    `codex://threads/${THREAD_ID}?hostId=local`,
    `codex://threads/${THREAD_ID}?view=review#latest`,
  ])("resolves a local native conversation identity: %s", (reference) => {
    expect(parseCodexThreadImportReference(reference)).toBe(THREAD_ID);
  });

  it.each([
    "",
    "not-a-thread",
    "nodex:thread:root",
    `${THREAD_ID}/extra`,
    `https://example.com/threads/${THREAD_ID}`,
    `file:///threads/${THREAD_ID}`,
    `codex://chat/${THREAD_ID}`,
    `codex://threads/`,
    `codex://threads/${THREAD_ID}/extra`,
    `codex://threads/%30${THREAD_ID.slice(1)}`,
    `codex://user:secret@threads/${THREAD_ID}`,
    `codex://threads:9229/${THREAD_ID}`,
    `codex://threads/${THREAD_ID}?hostId=remote-ssh:work`,
    `codex://threads/${THREAD_ID}?hostId=`,
    `codex://threads/${THREAD_ID}?hostId=local&hostId=remote`,
  ])("rejects remote or malformed references: %s", (reference) => {
    expect(parseCodexThreadImportReference(reference)).toBeNull();
  });
});
