import { expect, test, vi, describe, it } from "vite-plus/test";
import { createHostSessionObservation } from "./host-session-observation";
import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
  NativeSessionCatalogPage,
} from "../../shared/native-session-catalog";
import {
  createNativeConversationImportLedger,
  nativeConversationImportedCopy,
} from "./native-conversation-import-ledger";
import {
  nativeConversationCandidate,
  nativeConversationImportSelection,
  type NativeConversationCandidate,
  acceptNativeConversationImport,
  filterNativeConversations,
  latestNativeConversationCandidates,
  mergeNativeConversationCatalogs,
  NO_NATIVE_CONVERSATION_FILTERS,
  nativeConversationFiltersActive,
  nativeConversationFolderCounts,
  nativeConversationImportCwd,
  nativeConversationSourceKey,
  readNativeConversationCatalog,
  type NativeConversationFilters,
  type NativeConversationSource,
  type NativeConversationSourceCatalog,
} from "./native-conversation-import-model";

describe("host session observation", () => {
  test("hosted observation bounds targets and stops repair ticks after the final reader leaves", () => {
    vi.useFakeTimers();
    const observe = createHostSessionObservation();
    const releases: (() => void)[] = [];
    const notified = vi.fn();
    try {
      for (let i = 0; i < 8; i++)
        releases.push(observe({ sessionId: `session-${i}`, threadId: `thread-${i}` }, notified));
      expect(() => observe({ sessionId: "extra", threadId: "extra" }, notified)).toThrow(/eight/u);
      const sameTarget = vi.fn();
      releases.push(observe({ sessionId: "session-0", threadId: "thread-0" }, sameTarget));
      vi.advanceTimersByTime(15_000);
      expect(notified).toHaveBeenCalledTimes(8);
      expect(sameTarget).toHaveBeenCalledWith({
        type: "reset-required",
        sessionId: "session-0",
        threadId: "thread-0",
        reason: "host-refresh",
      });
      for (const release of releases) release();
      vi.advanceTimersByTime(10_000);
      expect(notified).toHaveBeenCalledTimes(8);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (const release of releases) release();
      vi.useRealTimers();
    }
  });

  test("coalesces targeted session invalidations before the next sparse repair", () => {
    vi.useFakeTimers();
    let invalidate:
      | ((event: import("../../shared/ipc-api").ProjectSessionsChangeEvent) => void)
      | undefined;
    const stop = vi.fn();
    const observe = createHostSessionObservation((listener) => {
      invalidate = listener;
      return stop;
    });
    const alice = vi.fn();
    const bob = vi.fn();
    const releaseAlice = observe({ sessionId: "alice", threadId: "a" }, alice);
    const releaseBob = observe({ sessionId: "bob", threadId: "b" }, bob);
    try {
      for (let i = 0; i < 20; i++)
        invalidate?.({
          changeType: "update",
          summaryScopes: [],
          detailInvalidation: { kind: "sessions", sessionIds: ["alice"] },
        });
      vi.advanceTimersByTime(1_000);
      expect(alice).toHaveBeenCalledOnce();
      expect(bob).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(alice).toHaveBeenCalledOnce();
      expect(bob).not.toHaveBeenCalled();
    } finally {
      releaseAlice();
      releaseBob();
      vi.useRealTimers();
    }
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("native conversation import ledger", () => {
  const source = (observedAt: number, imported?: { thread: string; session: string }) =>
    nativeConversationCandidate(
      { backendKind: "codex" },
      "/codex",
      {
        nativeSessionId: "0199a7c4-5b7e-7d10-9a3e-2f4b6c8d0e12",
        title: "Migrate billing",
        cwd: "/repo",
        updatedAt: 1,
        ...(imported
          ? { importedThreadId: imported.thread, importedSessionId: imported.session }
          : {}),
      },
      observedAt,
    );
  const selection = (candidate: NativeConversationCandidate, cwd = "/repo") =>
    nativeConversationImportSelection(candidate, cwd);
  const imported = (input: NativeConversationImportInput): NativeConversationImportOutcome => ({
    kind: "imported",
    sessionId: input.requestId,
    threadId: `thread-${input.requestId}`,
    projectId: null,
  });
  const deferred = () => {
    let resolve!: (outcome: NativeConversationImportOutcome) => void;
    let reject!: (cause: Error) => void;
    const promise = new Promise<NativeConversationImportOutcome>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  };

  describe("NativeConversationImportLedger", () => {
    it("lets only one submission per source be in flight, whoever asks", async () => {
      const ledger = createNativeConversationImportLedger();
      const reply = deferred();
      const send = vi.fn(() => reply.promise);
      const candidate = source(ledger.now());
      const first = ledger.submit(candidate, selection(candidate), send);
      // A second page, mounted later with other controls, joins the same submission.
      const second = ledger.submit(source(ledger.now()), selection(candidate, "/changed"), send);
      expect(send).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot().get(candidate.key)?.status).toBe("sending");

      reply.resolve({
        kind: "not_admitted",
        message: "This folder is no longer available. Refresh and choose another one.",
      });
      expect(await first).toEqual({
        kind: "not_admitted",
        message: "This folder is no longer available. Refresh and choose another one.",
      });
      expect(await second).toBe(await first);
      expect(ledger.snapshot().has(candidate.key)).toBe(false);
    });

    it("finishes an unknown outcome only with its own request and keeps its conversation", async () => {
      const ledger = createNativeConversationImportLedger();
      const send = vi
        .fn<(input: NativeConversationImportInput) => Promise<NativeConversationImportOutcome>>()
        // Electron names the channel before the reason; only the reason is the person's to read.
        .mockRejectedValueOnce(
          new Error(
            "Error invoking remote method 'native-sessions:import': Error: Agent Runtime is restarting.",
          ),
        )
        .mockImplementation(async (input) => imported(input));
      const candidate = source(ledger.now());
      expect(await ledger.submit(candidate, selection(candidate), send)).toEqual({
        kind: "unsettled",
        message: "Agent Runtime is restarting.",
      });
      const unsettled = ledger.snapshot().get(candidate.key);
      expect(unsettled).toMatchObject({ status: "unsettled", candidate });

      const changed = { ...source(ledger.now()), title: "Renamed elsewhere" };
      const settlement = await ledger.submit(changed, selection(changed, "/changed"), send);
      const [first, retry] = send.mock.calls.map(([input]) => input);
      expect(retry).toBe(first);
      expect(settlement).toEqual({
        kind: "imported",
        copy: { threadId: `thread-${first!.requestId}`, sessionId: first!.requestId },
      });
      expect(ledger.snapshot().get(candidate.key)).toMatchObject({ status: "imported", candidate });
    });

    it("starts a new request only after the previous one was not admitted", async () => {
      const ledger = createNativeConversationImportLedger();
      const send = vi
        .fn<(input: NativeConversationImportInput) => Promise<NativeConversationImportOutcome>>()
        .mockResolvedValueOnce({
          kind: "not_admitted",
          message:
            "This Claude Code profile is no longer available. Turn it on in Agent settings, then refresh.",
        })
        .mockImplementation(async (input) => imported(input));
      const candidate = source(ledger.now());
      await ledger.submit(candidate, selection(candidate), send);
      await ledger.submit(candidate, selection(candidate, "/changed"), send);
      const [rejected, fresh] = send.mock.calls.map(([input]) => input);
      expect(fresh!.requestId).not.toBe(rejected!.requestId);
      expect(fresh!.cwd).toBe("/changed");
    });

    it("protects a copy from reads sent before it settled, but not from later reads", async () => {
      const ledger = createNativeConversationImportLedger();
      const send = vi.fn(async (input: NativeConversationImportInput) => imported(input));
      const staleRead = source(ledger.now());
      const settlement = await ledger.submit(staleRead, selection(staleRead), send);
      expect(settlement.kind).toBe("imported");
      const entry = ledger.snapshot().get(staleRead.key);

      // A read sent before the copy existed cannot have reported it: the copy is offered, not redone.
      expect(nativeConversationImportedCopy(staleRead, entry)).toEqual(
        settlement.kind === "imported" ? settlement.copy : null,
      );
      expect(await ledger.submit(staleRead, selection(staleRead), send)).toEqual(settlement);
      expect(send).toHaveBeenCalledTimes(1);

      // A later read without the copy means it was deleted; importing again is a deliberate new copy.
      const laterRead = source(ledger.now());
      expect(nativeConversationImportedCopy(laterRead, entry)).toBeNull();
      await ledger.submit(laterRead, selection(laterRead), send);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0].requestId).not.toBe(send.mock.calls[0]![0].requestId);

      // The read's own report always wins.
      const reported = source(ledger.now(), { thread: "t", session: "s" });
      expect(nativeConversationImportedCopy(reported, undefined)).toEqual({
        threadId: "t",
        sessionId: "s",
      });
    });
  });
});

describe("native conversation import model", () => {
  const CODEX: NativeConversationSource = { backendKind: "codex" };
  const WORK: NativeConversationSource = { backendKind: "claude", instanceConfigId: "work" };
  const PERSONAL: NativeConversationSource = {
    backendKind: "claude",
    instanceConfigId: "personal",
  };

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
    const billing = row(CODEX, "billing", "Migrate BillingTables", "/repo/nodex");
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
      expect(
        nativeConversationFiltersActive({ ...NO_NATIVE_CONVERSATION_FILTERS, query: "x" }),
      ).toBe(true);
    });

    it("matches every word of a query across title and folder, in any order and case", () => {
      expect(shown({ query: "Ｂｉｌｌｉｎｇ＿ｔａｂｌｅｓ" })).toEqual(["billing"]);
      expect(shown({ query: "bililng" })).toEqual(["billing"]);
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
      expect(nativeConversationImportCwd(available, new Map())).toBe("/repo");
      expect(nativeConversationImportCwd(available, replacements)).toBe("/elsewhere");
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
      const selection = nativeConversationImportSelection(candidate, "/repo");
      expect(selection).toEqual({
        backendKind: "claude",
        instanceConfigId: "work",
        nativeSessionId: "id",
        expectedHome: "/claude",
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
  });
});
