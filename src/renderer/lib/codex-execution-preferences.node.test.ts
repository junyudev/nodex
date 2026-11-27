import { describe, expect, test } from "vite-plus/test";
import type { ThreadBackgroundTerminal } from "@nodex/codex-app-server-protocol/v2";
import type { CodexBackgroundProcessRow, TerminalSessionSnapshot } from "../../shared/types";
import {
  buildCodexBackgroundTerminalProcessRows,
  formatBackgroundTerminalCpuPercent,
  formatBackgroundTerminalMemoryKb,
  formatBackgroundTerminalPid,
  readBackgroundTerminalCpuPercent,
  readBackgroundTerminalMemoryKb,
} from "./codex-background-terminal-processes";
import {
  DEFAULT_CODEX_COLLABORATION_MODE,
  readGlobalCollaborationMode,
  writeGlobalCollaborationMode,
} from "./codex-collaboration-mode-settings";
import {
  CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY,
  buildCodexServiceTierRequestOverride,
  normalizeCodexServiceTier,
  readCodexServiceTier,
  resolveCodexRequestServiceTier,
  toServiceTierReportingValue,
  writeCodexServiceTier,
} from "./codex-service-tier-settings";
import {
  isCodexCompactWindowUrl,
  resolveCodexRendererCommandPlatform,
  resolveCodexRendererOsFromText,
  resolveCodexRendererWindowChrome,
} from "./codex-window-runtime";

describe("codex background terminal processes", () => {
  function terminal(overrides: Partial<ThreadBackgroundTerminal>): ThreadBackgroundTerminal {
    return {
      itemId: "item",
      processId: "process",
      command: "bun run dev",
      cwd: "/tmp",
      osPid: null,
      cpuPercent: null,
      rssKb: null,
      ...overrides,
    };
  }

  function processRow(
    threadId: string,
    threadTitle: string,
    terminalRow: ThreadBackgroundTerminal | null,
    overrides: Partial<CodexBackgroundProcessRow> = {},
  ): CodexBackgroundProcessRow {
    const itemId = terminalRow?.itemId ?? "item";
    const processId = terminalRow?.processId ?? "process";
    return {
      id: `${threadId}:${itemId}`,
      threadId,
      threadTitle,
      itemId,
      turnId: null,
      command: terminalRow?.command ?? "bun run preview",
      cwd: terminalRow?.cwd ?? "/tmp",
      processId,
      osPid: terminalRow?.osPid ?? null,
      terminalSessionId: null,
      source: "app-server",
      startedAtMs: 1,
      updatedAtMs: 2,
      status: terminalRow ? "running" : "not-found",
      terminal: terminalRow,
      terminalSession: null,
      ...overrides,
    };
  }

  function terminalSession(
    overrides: Partial<TerminalSessionSnapshot> = {},
  ): TerminalSessionSnapshot {
    return {
      sessionId: "terminal-session",
      conversationId: "thread",
      projectSessionId: null,
      osPid: 7301,
      cpuPercent: null,
      rssKb: null,
      childProcessCount: null,
      processMetricsSampledAtMs: null,
      cwd: "/tmp",
      shell: "/bin/zsh",
      title: "bun run dev",
      backendKind: "local",
      buffer: "",
      truncated: false,
      exited: false,
      exitCode: null,
      viewLease: null,
      ...overrides,
    };
  }

  describe("codex background terminal process rows", () => {
    test("sorts registered process rows by live CPU, then memory, then chat title", () => {
      const low = terminal({ itemId: "low", processId: "low", cpuPercent: 1, rssKb: 1024n });
      const tieAlpha = terminal({
        itemId: "tie-alpha",
        processId: "tie-alpha",
        cpuPercent: 10,
        rssKb: 4096n,
      });
      const top = terminal({ itemId: "top", processId: "top", cpuPercent: 20, rssKb: 1024n });
      const tieBeta = terminal({
        itemId: "tie-beta",
        processId: "tie-beta",
        cpuPercent: 10,
        rssKb: 2048n,
      });

      const rows = buildCodexBackgroundTerminalProcessRows(
        [
          { threadId: "thread-a", title: "Alpha" },
          { threadId: "thread-b", title: "Beta" },
        ],
        new Map([
          [
            "thread-a",
            [
              processRow("thread-a", "Alpha", low),
              processRow("thread-a", "Alpha", tieAlpha),
              processRow("thread-a", "Alpha", null, {
                id: "thread-a:offline",
                itemId: "offline",
                processId: "offline",
                command: "bun run preview",
              }),
            ],
          ],
          [
            "thread-b",
            [processRow("thread-b", "Beta", top), processRow("thread-b", "Beta", tieBeta)],
          ],
        ]),
      );

      expect(rows.map((row) => row.processId).join(",")).toBe("top,tie-alpha,tie-beta,low,offline");
    });

    test("sorts and reads terminal-action process rows by terminal session metrics", () => {
      const rows = buildCodexBackgroundTerminalProcessRows(
        [
          { threadId: "thread-a", title: "Alpha" },
          { threadId: "thread-b", title: "Beta" },
        ],
        new Map([
          [
            "thread-a",
            [
              processRow("thread-a", "Alpha", null, {
                id: "thread-a:local-low",
                itemId: "local-low",
                processId: null,
                terminalSessionId: "terminal-low",
                terminalSession: terminalSession({
                  sessionId: "terminal-low",
                  cpuPercent: 2,
                  rssKb: 4096n,
                }),
              }),
            ],
          ],
          [
            "thread-b",
            [
              processRow("thread-b", "Beta", null, {
                id: "thread-b:local-high",
                itemId: "local-high",
                processId: null,
                terminalSessionId: "terminal-high",
                terminalSession: terminalSession({
                  sessionId: "terminal-high",
                  cpuPercent: 11,
                  rssKb: 1024n,
                }),
              }),
            ],
          ],
        ]),
      );

      expect(rows.map((row) => row.terminalSessionId).join(",")).toBe("terminal-high,terminal-low");
      expect(readBackgroundTerminalCpuPercent(rows[0]!)).toBe(11);
      expect(readBackgroundTerminalMemoryKb(rows[1]!)).toBe(4096n);
    });

    test("formats CPU, memory, and PID values from protocol rows", () => {
      expect(formatBackgroundTerminalCpuPercent(12.345)).toBe("12.3%");
      expect(formatBackgroundTerminalCpuPercent(null)).toBe("n/a");
      expect(formatBackgroundTerminalMemoryKb(512n)).toBe("512 KB");
      expect(formatBackgroundTerminalMemoryKb(1536n)).toBe("1.5 MB");
      expect(formatBackgroundTerminalMemoryKb(2_097_152n)).toBe("2.00 GB");
      expect(formatBackgroundTerminalMemoryKb(null)).toBe("n/a");
      expect(
        formatBackgroundTerminalPid(
          processRow("thread", "Thread", terminal({ processId: "app-proc", osPid: 4312 })),
        ),
      ).toBe("4312");
      expect(
        formatBackgroundTerminalPid(
          processRow("thread", "Thread", terminal({ processId: "app-proc", osPid: null })),
        ),
      ).toBe("app-proc");
      expect(
        formatBackgroundTerminalPid(processRow("thread", "Thread", null, { processId: null })),
      ).toBe("n/a");
    });
  });
});

describe("codex collaboration mode settings", () => {
  const mockStorage = {
    store: new Map<string, string>(),
    getItem(key: string) {
      return this.store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      this.store.set(key, value);
    },
    removeItem(key: string) {
      this.store.delete(key);
    },
    clear() {
      this.store.clear();
    },
  };

  describe("codex collaboration mode settings", () => {
    test("falls back to default mode when storage is missing or invalid", () => {
      const storageGlobal = globalThis as unknown as { localStorage?: typeof mockStorage };
      const previousLocalStorage = storageGlobal.localStorage;
      storageGlobal.localStorage = mockStorage;
      mockStorage.clear();

      try {
        expect(readGlobalCollaborationMode()).toBe(DEFAULT_CODEX_COLLABORATION_MODE);

        mockStorage.setItem("nodex-codex-collaboration-mode-v2", "invalid");
        expect(readGlobalCollaborationMode()).toBe(DEFAULT_CODEX_COLLABORATION_MODE);
      } finally {
        if (previousLocalStorage) {
          storageGlobal.localStorage = previousLocalStorage;
        } else {
          delete storageGlobal.localStorage;
        }
      }
    });

    test("round-trips the global collaboration mode", () => {
      const storageGlobal = globalThis as unknown as { localStorage?: typeof mockStorage };
      const previousLocalStorage = storageGlobal.localStorage;
      storageGlobal.localStorage = mockStorage;
      mockStorage.clear();

      try {
        writeGlobalCollaborationMode("plan");
        expect(readGlobalCollaborationMode()).toBe("plan");
        writeGlobalCollaborationMode("default");
        expect(readGlobalCollaborationMode()).toBe("default");
      } finally {
        if (previousLocalStorage) {
          storageGlobal.localStorage = previousLocalStorage;
        } else {
          delete storageGlobal.localStorage;
        }
      }
    });
  });
});

describe("codex service tier settings", () => {
  const storageMap = new Map<string, string>();

  const mockStorage = {
    getItem(key: string): string | null {
      return storageMap.has(key) ? (storageMap.get(key) ?? null) : null;
    },
    setItem(key: string, value: string): void {
      storageMap.set(key, value);
    },
    removeItem(key: string): void {
      storageMap.delete(key);
    },
  };

  if (!(globalThis as { localStorage?: unknown }).localStorage) {
    (globalThis as { localStorage: typeof mockStorage }).localStorage = mockStorage;
  }

  const localStorageRef = (globalThis as { localStorage: typeof mockStorage }).localStorage;

  function resetStorage(): void {
    storageMap.clear();
    localStorageRef.removeItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY);
  }

  describe("codex-service-tier-settings", () => {
    test("preserves service tiers supplied by newer model catalogs", () => {
      resetStorage();
      localStorageRef.setItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY, "flex");

      expect(normalizeCodexServiceTier("fast")).toBe("fast");
      expect(normalizeCodexServiceTier(" flex ")).toBe("flex");
      expect(normalizeCodexServiceTier("default")).toBeNull();
      expect(readCodexServiceTier()).toBe("flex");
    });

    test("writes fast and clears the stored key for standard", () => {
      resetStorage();

      expect(writeCodexServiceTier("fast")).toBe("fast");
      expect(localStorageRef.getItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY)).toBe("fast");
      expect(readCodexServiceTier()).toBe("fast");

      expect(writeCodexServiceTier(null)).toBe(null);
      expect(localStorageRef.getItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY)).toBe(null);
      expect(readCodexServiceTier()).toBe(null);
    });

    test("reports the selected speed and fits a new chat default to its model", () => {
      resetStorage();

      expect(toServiceTierReportingValue(null)).toBe("standard");
      expect(toServiceTierReportingValue("fast")).toBe("fast");
      const model = { serviceTiers: [{ id: "priority", name: "Fast", description: "" }] };
      expect(resolveCodexRequestServiceTier(undefined, "ultrafast", model)).toBe("fast");
      // A model the catalog has not described yet keeps the default rather than dropping it.
      expect(resolveCodexRequestServiceTier({}, "ultrafast", undefined)).toBe("ultrafast");
      expect(resolveCodexRequestServiceTier({ serviceTier: null }, "ultrafast", model)).toBeNull();
      expect(resolveCodexRequestServiceTier({ serviceTier: "priority" }, null, model)).toBe("fast");
      expect(resolveCodexRequestServiceTier(undefined, "fast", { serviceTiers: [] })).toBeNull();
    });

    test("distinguishes inheriting a Thread tier from explicitly clearing Fast", () => {
      expect(buildCodexServiceTierRequestOverride(undefined)).toEqual({});
      expect(buildCodexServiceTierRequestOverride(null)).toEqual({ serviceTier: null });
      expect(buildCodexServiceTierRequestOverride("fast")).toEqual({ serviceTier: "fast" });
    });
  });
});

describe("codex window runtime helpers", () => {
  test.each([
    ["MacIntel", "", "macOS"],
    ["Win32", "", "windows"],
    ["Linux x86_64", "", "linux"],
    ["", "Linux browser", "linux"],
    ["Plan 9", "", "linux"],
  ] as const)("projects %s/%s to command platform %s", (platform, userAgent, expected) => {
    expect(resolveCodexRendererCommandPlatform({ platform, userAgent })).toBe(expected);
  });

  test("normalizes renderer OS from navigator platform text", () => {
    expect(resolveCodexRendererOsFromText("MacIntel")).toBe("darwin");
    expect(resolveCodexRendererOsFromText("Win32")).toBe("win32");
    expect(resolveCodexRendererOsFromText("Linux x86_64")).toBe("linux");
    expect(resolveCodexRendererOsFromText("Plan 9")).toBe("unknown");
  });

  test("matches Codex Electron window chrome by platform", () => {
    expect(resolveCodexRendererWindowChrome("browser", "win32")).toBe("native");
    expect(resolveCodexRendererWindowChrome("electron", "darwin")).toBe("native");
    expect(resolveCodexRendererWindowChrome("electron", "unknown")).toBe("native");
    expect(resolveCodexRendererWindowChrome("electron", "linux")).toBe("application-menu");
    expect(resolveCodexRendererWindowChrome("electron", "win32")).toBe("application-menu");
  });

  test("detects compact Codex window routes", () => {
    expect(isCodexCompactWindowUrl("app://-/avatar-overlay")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/global-dictation")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/global-dictation/session")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/mini")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/?initialRoute=/mini")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/?initialRoute=/avatar-overlay?x=1")).toBe(true);
    expect(isCodexCompactWindowUrl("app://-/")).toBe(false);
    expect(isCodexCompactWindowUrl("app://-/settings")).toBe(false);
    expect(isCodexCompactWindowUrl("not a url")).toBe(false);
  });
});
