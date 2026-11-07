import { describe, expect, it } from "vite-plus/test";
import {
  acceptNativeConversationImport,
  filterNativeConversations,
  latestNativeConversationCandidates,
  mergeNativeConversationCatalogs,
  NO_NATIVE_CONVERSATION_FILTERS,
  nativeConversationCandidate,
  nativeConversationFiltersActive,
  nativeConversationFolderCounts,
  nativeConversationImportCwd,
  nativeConversationImportSelection,
  nativeConversationSourceKey,
  readNativeConversationCatalog,
  type NativeConversationFilters,
  type NativeConversationSource,
  type NativeConversationSourceCatalog,
} from "./native-conversation-import-model";

import type { NativeSessionCatalogPage } from "../../shared/native-session-catalog";

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
  merged.map((candidate) => candidate.updatedAt);

describe("mergeNativeConversationCatalogs", () => {
  it("interleaves exhausted sources by recency", () => {
    const merged = mergeNativeConversationCatalogs([
      catalog(CODEX, "/codex", [90, 50, 10]),
      catalog(WORK, "/claude", [70, 30]),
    ]);
    expect(times(merged)).toEqual([90, 70, 50, 30, 10]);
  });

  it("holds back rows that an unread page could still precede", () => {
    const merged = mergeNativeConversationCatalogs([
      catalog(CODEX, "/codex", [90, 60], "codex-2"),
      catalog(WORK, "/claude", [80, 40, 20]),
    ]);
    expect(times(merged)).toEqual([90, 80, 60]);
  });

  it("is bounded by the unread source that reaches least far back", () => {
    const merged = mergeNativeConversationCatalogs([
      catalog(CODEX, "/codex", [90, 30], "codex-2"),
      catalog(WORK, "/claude", [80, 50], "claude-2"),
    ]);
    expect(times(merged)).toEqual([90, 80, 50]);
  });

  it("is not bounded by a source with a cursor but no rows yet", () => {
    const merged = mergeNativeConversationCatalogs([
      catalog(CODEX, "/codex", [90, 30]),
      catalog(PERSONAL, "/claude-personal", [], "personal-2"),
    ]);
    expect(times(merged)).toEqual([90, 30]);
  });

  it("treats profiles sharing a history home as one source", () => {
    const merged = mergeNativeConversationCatalogs([
      catalog(WORK, "/claude", [80, 40]),
      catalog(PERSONAL, "/claude", [80, 40], "alias-2"),
    ]);
    expect(times(merged)).toEqual([80, 40]);
    expect(merged.every((candidate) => candidate.source === WORK)).toBe(true);
  });
});

describe("readNativeConversationCatalog", () => {
  const page = (
    ids: readonly string[],
    nextCursor: string | null,
    nativeHome = "/codex",
  ): NativeSessionCatalogPage => ({
    nativeHome,
    nextCursor,
    entries: ids.map((id) => ({ nativeSessionId: id, title: id, cwd: "/repo", updatedAt: 1 })),
  });
  const read = (
    pages: Record<string, NativeSessionCatalogPage>,
    options: {
      readonly resume?: NativeConversationSourceCatalog;
      readonly isCurrent?: () => boolean;
    } = {},
  ) => {
    const reads: (string | null)[] = [];
    const progress: string[][] = [];
    const ids = (value: NativeConversationSourceCatalog) =>
      value.candidates.map((candidate) => candidate.nativeSessionId);
    const result = readNativeConversationCatalog({
      source: CODEX,
      resume: options.resume ?? null,
      list: async (cursor) => {
        reads.push(cursor);
        return pages[cursor ?? "first"]!;
      },
      now: () => 0,
      isCurrent: options.isCurrent ?? (() => true),
      onProgress: (next) => progress.push(ids(next)),
    }).then((value) => (value ? ids(value) : null));
    return { reads, progress, result };
  };

  it("reads every page, reporting each unfinished step", async () => {
    const run = read({ first: page(["a"], "2"), 2: page([], "3"), 3: page(["b"], null) });
    expect(await run.result).toEqual(["a", "b"]);
    expect(run.reads).toEqual([null, "2", "3"]);
    expect(run.progress).toEqual([["a"], ["a"]]);
  });

  it("continues after a catalog that stopped partway", async () => {
    const resume = catalog(CODEX, "/codex", [9], "2");
    const run = read({ 2: page(["b"], null) }, { resume });
    expect(await run.result).toEqual(["codex-9", "b"]);
    expect(run.reads).toEqual(["2"]);
  });

  it("starts over when the history home changed underneath it", async () => {
    const resume = catalog(CODEX, "/codex", [9], "2");
    const run = read({ 2: page(["b"], null, "/other") }, { resume });
    expect(await run.result).toEqual(["b"]);
  });

  it("ends when a cursor stops advancing", async () => {
    const run = read({ first: page(["a"], "2"), 2: page(["b"], "2") });
    expect(await run.result).toEqual(["a", "b"]);
    expect(run.reads).toEqual([null, "2"]);
  });

  it("gives nothing back once nobody wants it", async () => {
    let current = true;
    const run = read(
      { first: page(["a"], "2"), 2: page(["b"], "3") },
      {
        isCurrent: () => {
          const answer = current;
          current = false;
          return answer;
        },
      },
    );
    expect(await run.result).toBeNull();
    expect(run.reads).toEqual([null, "2"]);
    expect(run.progress).toEqual([["a"]]);
  });
});

describe("filterNativeConversations", () => {
  const row = (
    source: NativeConversationSource,
    id: string,
    title: string,
    cwd: string,
    importedThreadId?: string,
  ) =>
    nativeConversationCandidate(
      source,
      `/${source.backendKind}`,
      {
        nativeSessionId: id,
        title,
        cwd,
        updatedAt: 1,
        ...(importedThreadId ? { importedThreadId, importedSessionId: "session" } : {}),
      },
      0,
    );
  const billing = row(CODEX, "billing", "Migrate Billing tables", "/repo/nodex");
  const auth = row(WORK, "auth", "修复登录问题", "/repo/nodex/.agents/worktrees/auth");
  const docs = row(CODEX, "docs", "Rewrite the docs", "/repo/landing", "copy");
  const all = [billing, auth, docs];
  const shown = (filters: Partial<NativeConversationFilters>, selected: readonly string[] = []) =>
    filterNativeConversations(all, { ...NO_NATIVE_CONVERSATION_FILTERS, ...filters }, (key) =>
      selected.includes(key),
    ).map((candidate) => candidate.nativeSessionId);

  it("lets everything through until something narrows it", () => {
    expect(shown({})).toEqual(["billing", "auth", "docs"]);
    expect(nativeConversationFiltersActive(NO_NATIVE_CONVERSATION_FILTERS)).toBe(false);
    expect(
      nativeConversationFiltersActive({ ...NO_NATIVE_CONVERSATION_FILTERS, query: "  " }),
    ).toBe(false);
    expect(nativeConversationFiltersActive({ ...NO_NATIVE_CONVERSATION_FILTERS, query: "x" })).toBe(
      true,
    );
  });

  it("matches every word of a query across title and folder, in any order and case", () => {
    expect(shown({ query: "billing" })).toEqual(["billing"]);
    expect(shown({ query: "TABLES migrate" })).toEqual(["billing"]);
    expect(shown({ query: "登录" })).toEqual(["auth"]);
    expect(shown({ query: "worktrees" })).toEqual(["auth"]);
    expect(shown({ query: "nodex billing" })).toEqual(["billing"]);
    expect(shown({ query: "billing landing" })).toEqual([]);
  });

  it("treats a folder as that exact directory, not the ones beneath it", () => {
    expect(shown({ cwd: "/repo/nodex" })).toEqual(["billing"]);
  });

  it("narrows by source and by imported state", () => {
    expect(shown({ sourceKey: nativeConversationSourceKey(WORK) })).toEqual(["auth"]);
    expect(shown({ status: "imported" })).toEqual(["docs"]);
    expect(shown({ status: "not_imported" })).toEqual(["billing", "auth"]);
  });

  it("shows only what is selected, however it was found", () => {
    expect(shown({ status: "selected" }, [billing.key, docs.key])).toEqual(["billing", "docs"]);
  });

  it("intersects every dimension", () => {
    expect(shown({ query: "repo", status: "not_imported", cwd: "/repo/nodex" })).toEqual([
      "billing",
    ]);
  });
});

describe("nativeConversationFolderCounts", () => {
  const inFolder = (id: string, cwd: string) =>
    nativeConversationCandidate(
      CODEX,
      "/codex",
      { nativeSessionId: id, title: id, cwd, updatedAt: 1 },
      0,
    );

  it("puts the fullest folders first and breaks ties by the list's order", () => {
    expect(
      nativeConversationFolderCounts([
        inFolder("a", "/recent"),
        inFolder("b", "/busy"),
        inFolder("c", "/busy"),
        inFolder("d", "/older"),
      ]),
    ).toEqual([
      { cwd: "/busy", count: 2 },
      { cwd: "/recent", count: 1 },
      { cwd: "/older", count: 1 },
    ]);
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
