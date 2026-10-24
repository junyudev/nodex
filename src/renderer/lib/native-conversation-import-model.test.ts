import { describe, expect, it } from "vite-plus/test";
import {
  acceptNativeConversationImport,
  latestNativeConversationCandidates,
  mergeNativeConversationCatalogs,
  nativeConversationCandidate,
  nativeConversationImportCwd,
  nativeConversationImportSelection,
  type NativeConversationSource,
  type NativeConversationSourceCatalog,
} from "./native-conversation-import-model";

const CODEX: NativeConversationSource = { backendKind: "codex" };
const WORK: NativeConversationSource = { backendKind: "claude", instanceConfigId: "work" };
const PERSONAL: NativeConversationSource = { backendKind: "claude", instanceConfigId: "personal" };

const catalog = (
  source: NativeConversationSource,
  nativeHome: string,
  updatedAt: readonly number[],
  nextCursor: string | null = null,
): NativeConversationSourceCatalog => ({
  source,
  nativeHome,
  nextCursor,
  candidates: updatedAt.map((time) =>
    nativeConversationCandidate(
      source,
      nativeHome,
      {
        nativeSessionId: `${source.backendKind}-${time}`,
        title: `At ${time}`,
        cwd: "/repo",
        updatedAt: time,
      },
      0,
    ),
  ),
});
const times = (merged: ReturnType<typeof mergeNativeConversationCatalogs>) =>
  merged.candidates.map((candidate) => candidate.updatedAt);

describe("mergeNativeConversationCatalogs", () => {
  it("interleaves exhausted sources by recency", () => {
    const merged = mergeNativeConversationCatalogs([
      catalog(CODEX, "/codex", [90, 50, 10]),
      catalog(WORK, "/claude", [70, 30]),
    ]);
    expect(times(merged)).toEqual([90, 70, 50, 30, 10]);
    expect(merged.next).toBeNull();
  });

  it("holds back rows that an unread page could still precede, and reads that page next", () => {
    const codex = catalog(CODEX, "/codex", [90, 60], "codex-2");
    const claude = catalog(WORK, "/claude", [80, 40, 20]);
    const merged = mergeNativeConversationCatalogs([codex, claude]);
    expect(times(merged)).toEqual([90, 80, 60]);
    expect(merged.next).toBe(codex);
  });

  it("extends from the source whose oldest loaded row is newest", () => {
    const codex = catalog(CODEX, "/codex", [90, 30], "codex-2");
    const claude = catalog(WORK, "/claude", [80, 50], "claude-2");
    const merged = mergeNativeConversationCatalogs([codex, claude]);
    expect(times(merged)).toEqual([90, 80, 50]);
    expect(merged.next).toBe(claude);
  });

  it("reads a source with a cursor but no rows before bounding the others", () => {
    const empty = catalog(PERSONAL, "/claude-personal", [], "personal-2");
    const codex = catalog(CODEX, "/codex", [90, 30], "codex-2");
    const merged = mergeNativeConversationCatalogs([codex, empty]);
    expect(times(merged)).toEqual([90, 30]);
    expect(merged.next).toBe(empty);
  });

  it("treats profiles sharing a history home as one source", () => {
    const work = catalog(WORK, "/claude", [80, 40]);
    const alias = catalog(PERSONAL, "/claude", [80, 40], "alias-2");
    const merged = mergeNativeConversationCatalogs([work, alias]);
    expect(times(merged)).toEqual([80, 40]);
    expect(merged.candidates.every((candidate) => candidate.source === WORK)).toBe(true);
    expect(merged.next).toBeNull();
  });
});

describe("latestNativeConversationCandidates", () => {
  it("keeps a row where it was first placed but shows what the newest read found", () => {
    const entry = { nativeSessionId: "pasted", title: "Pasted", cwd: "/repo", updatedAt: 5 };
    const pasted = nativeConversationCandidate(
      CODEX,
      "/codex",
      { ...entry, importedThreadId: "deleted-copy", importedSessionId: "deleted-session" },
      1,
    );
    const other = nativeConversationCandidate(
      CODEX,
      "/codex",
      { ...entry, nativeSessionId: "other", title: "Other", updatedAt: 9 },
      2,
    );
    const browsed = nativeConversationCandidate(
      CODEX,
      "/codex",
      { ...entry, cwdAvailable: false },
      2,
    );
    const rows = latestNativeConversationCandidates([pasted, other, browsed]);
    expect(rows.map((row) => row.nativeSessionId)).toEqual(["pasted", "other"]);
    expect(rows[0]).toBe(browsed);
    expect(rows[0]!.imported).toBeNull();
    expect(rows[0]!.cwdAvailable).toBe(false);
    expect(latestNativeConversationCandidates([browsed, pasted])[0]).toBe(browsed);
  });
});

describe("nativeConversationCandidate", () => {
  it("offers an existing copy only when both of its identities are known", () => {
    const entry = { nativeSessionId: "id", title: "T", cwd: "/repo", updatedAt: 1 };
    expect(nativeConversationCandidate(CODEX, "/codex", entry, 0).imported).toBeNull();
    expect(
      nativeConversationCandidate(
        CODEX,
        "/codex",
        { ...entry, importedThreadId: "thread", importedSessionId: "session" },
        0,
      ).imported,
    ).toEqual({ threadId: "thread", sessionId: "session" });
  });
});

describe("nativeConversationImportCwd", () => {
  const entry = { nativeSessionId: "id", title: "T", updatedAt: 1 };
  it("uses an available original and requires an explicit replacement for a missing one", () => {
    const available = nativeConversationCandidate(CODEX, "/codex", { ...entry, cwd: "/repo" }, 0);
    const missing = nativeConversationCandidate(
      CODEX,
      "/codex",
      { ...entry, cwd: "/gone", cwdAvailable: false },
      0,
    );
    const replacements = new Map([
      ["/gone", "/moved"],
      ["/repo", "/elsewhere"],
    ]);
    expect(nativeConversationImportCwd(available, replacements)).toBe("/repo");
    expect(nativeConversationImportCwd(missing, new Map())).toBeNull();
    expect(nativeConversationImportCwd(missing, replacements)).toBe("/moved");
  });
});

describe("nativeConversationImportSelection", () => {
  const candidate = nativeConversationCandidate(
    WORK,
    "/claude",
    { nativeSessionId: "id", title: "T", cwd: "/repo", updatedAt: 1 },
    0,
  );

  it("names the Claude profile and gives each accepted request its own identity", () => {
    const selection = nativeConversationImportSelection(candidate, "project", "/repo");
    expect(selection).toEqual({
      backendKind: "claude",
      instanceConfigId: "work",
      nativeSessionId: "id",
      expectedHome: "/claude",
      projectId: "project",
      cwd: "/repo",
    });
    const first = acceptNativeConversationImport(selection);
    expect(first).toEqual({
      ...selection,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      acceptedAt: expect.any(Number),
    });
    expect(acceptNativeConversationImport(selection).requestId).not.toBe(first.requestId);
  });

  it("never sends a profile for Codex", () => {
    const codex = nativeConversationCandidate(
      { backendKind: "codex", instanceConfigId: "ignored" },
      "/codex",
      { nativeSessionId: "id", title: "T", cwd: "/repo", updatedAt: 1 },
      0,
    );
    expect("instanceConfigId" in nativeConversationImportSelection(codex, null, "/repo")).toBe(
      false,
    );
  });
});
