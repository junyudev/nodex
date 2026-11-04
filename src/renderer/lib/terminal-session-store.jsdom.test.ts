import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { TERMINAL_RENDERER_BUFFER_LIMIT, TerminalSessionStore } from "./terminal-session-store";
import type { TerminalRenderer } from "./terminal-renderer";
import type {
  TerminalAttachedEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInitLogEvent,
  TerminalSessionSnapshot,
} from "../../shared/types";

const originalApi = window.api;

function makeSnapshot(
  input: Partial<TerminalSessionSnapshot> & { sessionId: string },
): TerminalSessionSnapshot {
  return {
    sessionId: input.sessionId,
    conversationId: input.conversationId ?? null,
    projectSessionId: input.projectSessionId ?? null,
    osPid: input.osPid ?? null,
    cpuPercent: input.cpuPercent ?? null,
    rssKb: input.rssKb ?? null,
    childProcessCount: input.childProcessCount ?? null,
    processMetricsSampledAtMs: input.processMetricsSampledAtMs ?? null,
    cwd: input.cwd ?? null,
    shell: input.shell ?? "/bin/zsh",
    title: input.title ?? null,
    backendKind: input.backendKind ?? "local",
    buffer: input.buffer ?? "",
    truncated: input.truncated ?? false,
    exited: input.exited ?? false,
    exitCode: input.exitCode ?? null,
    viewLease: input.viewLease ?? null,
  };
}

function installTerminalApiMock(
  options: {
    invoke?: (channel: string, ...args: unknown[]) => unknown;
  } = {},
) {
  const listeners: Record<string, (payload: unknown) => void> = {};
  const calls: unknown[] = [];
  window.api = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push([channel, ...args]);
      if (options.invoke) return options.invoke(channel, ...args);
      if (
        channel === "terminal-create" ||
        channel === "terminal-acquire-view" ||
        channel === "terminal-take-over-view"
      ) {
        const input = args[0] as { sessionId: string };
        return {
          status: "acquired",
          generation: 1,
          snapshot: makeSnapshot({
            sessionId: input.sessionId,
            viewLease: {
              windowSessionId: "window-session-1",
              generation: 1,
              size: { cols: 80, rows: 24 },
            },
          }),
        };
      }
      return undefined;
    },
    on: (event: string, callback: (...args: unknown[]) => void) => {
      listeners[event] = (payload: unknown) => callback(payload);
      return () => {
        delete listeners[event];
      };
    },
  };
  return { calls, listeners };
}

function makeRenderer() {
  let onTitle: ((value: string) => void) | undefined;
  const replaceOutput = vi.fn();
  const dispose = vi.fn();
  const renderer = {
    terminal: {
      onTitleChange: (listener: (value: string) => void) => {
        onTitle = listener;
      },
    },
    replaceOutput,
    write: vi.fn(),
    clear: vi.fn(),
    dispose,
  } as unknown as TerminalRenderer;
  return { renderer, replaceOutput, dispose, title: (value: string) => onTitle?.(value) };
}

describe("TerminalSessionStore", () => {
  beforeEach(() => {
    window.api = originalApi;
  });

  afterEach(() => {
    window.api = originalApi;
  });

  test("queues writes until the terminal is attached and registered", async () => {
    const { calls, listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();

    const attaching = store.createOrAttach({
      sessionId: "session:one:terminal:1",
      conversationId: "thread-1",
      projectSessionId: "session-1",
      cwd: "/repo",
      size: { cols: 80, rows: 24 },
    });
    store.write("session:one:terminal:1", "pwd\r", "user");
    expect(calls).toHaveLength(1);
    await attaching;
    expect(calls).toHaveLength(1);

    listeners["terminal-attached"]?.({
      sessionId: "session:one:terminal:1",
      snapshot: makeSnapshot({
        sessionId: "session:one:terminal:1",
        conversationId: "thread-1",
        projectSessionId: "session-1",
        cwd: "/repo",
      }),
    } satisfies TerminalAttachedEvent);

    const onAttach = vi.fn();
    store.register("session:one:terminal:1", { onAttach });
    expect(onAttach).toHaveBeenCalledWith("/repo", "/bin/zsh");
    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        [
          "terminal-create",
          {
            sessionId: "session:one:terminal:1",
            conversationId: "thread-1",
            projectSessionId: "session-1",
            cwd: "/repo",
            size: { cols: 80, rows: 24 },
          },
        ],
        ["terminal-write", "session:one:terminal:1", "pwd\r"],
      ]),
    );
  });

  test("uses cwd basename before terminal fallback title", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();

    listeners["terminal-attached"]?.({
      sessionId: "session:one:terminal:2",
      snapshot: makeSnapshot({
        sessionId: "session:one:terminal:2",
        cwd: "/Users/asc/repo/nodex",
      }),
    } satisfies TerminalAttachedEvent);

    expect(store.resolveTitle("session:one:terminal:2", "Terminal", 2)).toBe("nodex");
  });

  test("keeps the latest renderer terminal buffer within the retained output limit", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();

    listeners["terminal-data"]?.({
      sessionId: "session:one:terminal:3",
      data: "a".repeat(TERMINAL_RENDERER_BUFFER_LIMIT + 12),
    } satisfies TerminalDataEvent);

    const snapshot = store.getSnapshot("session:one:terminal:3");
    expect(snapshot.buffer.length).toBe(TERMINAL_RENDERER_BUFFER_LIMIT);
    expect(snapshot.truncated).toBe(true);
  });

  test("runs terminal actions and fetches buffered snapshots", async () => {
    const { calls } = installTerminalApiMock();
    const store = new TerminalSessionStore();

    await store.runAction({
      sessionId: "process:thread:item:action",
      conversationId: "thread-action",
      cwd: "/repo",
      command: "bun run dev",
      title: "bun run dev",
    });
    const snapshot = await store.fetchSnapshot("process:thread:item:action");

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        [
          "terminal-run-action",
          {
            sessionId: "process:thread:item:action",
            conversationId: "thread-action",
            cwd: "/repo",
            command: "bun run dev",
            title: "bun run dev",
          },
        ],
        ["terminal-session:snapshot", "process:thread:item:action"],
      ]),
    );
    expect(snapshot === null).toBe(true);
  });

  test("does not invalidate global tab-title subscribers for terminal output chunks", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    let versionEvents = 0;
    store.ensureEventSubscriptions();
    store.subscribeAll(() => {
      versionEvents += 1;
    });

    listeners["terminal-data"]?.({
      sessionId: "session:one:terminal:4",
      data: "prompt",
    } satisfies TerminalDataEvent);

    expect(store.getSnapshot("session:one:terminal:4").buffer).toBe("prompt");
    expect(versionEvents).toBe(0);
  });

  test("releases a terminal view at most once without killing its runtime", () => {
    const { calls, listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();

    store.release("session:one:terminal:close-once");
    listeners["terminal-exit"]?.({
      sessionId: "session:one:terminal:close-once",
      exitCode: 0,
      reason: "exited",
    } satisfies TerminalExitEvent);
    store.release("session:one:terminal:close-once");

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([["terminal-release-view", "session:one:terminal:close-once"]]),
    );
  });

  test("kills a terminal only through the explicit destructive command", async () => {
    const { calls, listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();
    const sessionId = "session:one:terminal:kill";
    listeners["terminal-data"]?.({ sessionId, data: "\x1b[?1049h" });
    store.kill(sessionId);
    await expect.poll(() => store.getPreservedAlternateScreenMode(sessionId)).toBeNull();
    expect(store.getSnapshot(sessionId).buffer).toBe("");
    expect(calls).toEqual([["terminal-kill", sessionId]]);
  });

  test("surfaces a lease conflict and takes over with its generation", async () => {
    const sessionId = "session:one:terminal:conflict";
    const { calls } = installTerminalApiMock({
      invoke: (channel) => {
        if (channel === "terminal-acquire-view") {
          return {
            status: "conflict",
            generation: 4,
            ownerWindowSessionId: "window-session-other",
            snapshot: makeSnapshot({
              sessionId,
              buffer: "still running",
              viewLease: {
                windowSessionId: "window-session-other",
                generation: 4,
                size: { cols: 100, rows: 30 },
              },
            }),
          };
        }
        if (channel === "terminal-take-over-view") {
          return {
            status: "acquired",
            generation: 5,
            snapshot: makeSnapshot({
              sessionId,
              viewLease: {
                windowSessionId: "window-session-current",
                generation: 5,
                size: { cols: 90, rows: 28 },
              },
            }),
          };
        }
        return undefined;
      },
    });
    const store = new TerminalSessionStore();

    await store.attach({
      sessionId,
      size: { cols: 90, rows: 28 },
    });
    expect(store.getLeaseConflict(sessionId)).toEqual({
      generation: 4,
      ownerWindowSessionId: "window-session-other",
    });
    expect(store.getSnapshot(sessionId).buffer).toBe("still running");

    await store.takeOver({
      sessionId,
      expectedGeneration: 4,
      size: { cols: 90, rows: 28 },
    });

    expect(store.getLeaseConflict(sessionId)).toBeNull();
    expect(calls.at(-1)).toEqual([
      "terminal-take-over-view",
      {
        sessionId,
        expectedGeneration: 4,
        size: { cols: 90, rows: 28 },
      },
    ]);
  });

  test("replays the retained output and rebases clear offsets after tail trimming", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();
    const sessionId = "retained";
    const before = makeRenderer();
    store.getOrCreateRenderer(sessionId, () => before.renderer);
    const emit = (data: string) =>
      listeners["terminal-data"]?.({ sessionId, data } satisfies TerminalDataEvent);

    emit("evicted");
    store.clearSession(sessionId);
    emit("0123456789");
    store.clearSession(sessionId);
    emit("x".repeat(TERMINAL_RENDERER_BUFFER_LIMIT - 5));
    store.release(sessionId);

    expect(before.dispose).toHaveBeenCalledOnce();
    const after = makeRenderer();
    store.getOrCreateRenderer(sessionId, () => after.renderer);
    store.clearSession(sessionId);
    expect(after.replaceOutput).toHaveBeenCalledWith(
      "56789" + "x".repeat(TERMINAL_RENDERER_BUFFER_LIMIT - 5),
      [5],
    );
  });

  test("restores only the init event data, even when the lease snapshot contains historical queries", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();
    const sessionId = "sanitized";
    const mounted = makeRenderer();
    store.getOrCreateRenderer(sessionId, () => mounted.renderer);
    const snapshot = makeSnapshot({ sessionId, buffer: "\x1b[6nraw" });
    listeners["terminal-init-log"]?.({
      sessionId,
      data: "raw",
      snapshot,
    } satisfies TerminalInitLogEvent);
    listeners["terminal-attached"]?.({ sessionId, snapshot } satisfies TerminalAttachedEvent);
    store.release(sessionId);

    const remounted = makeRenderer();
    store.getOrCreateRenderer(sessionId, () => remounted.renderer);
    expect(mounted.replaceOutput).toHaveBeenCalledWith("raw", [], undefined);
    expect(remounted.replaceOutput).toHaveBeenCalledWith("raw", []);
  });

  test("scans split DEC modes and RIS, bounding incomplete sequences", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();
    const sessionId = "alternate";
    const emit = (data: string) =>
      listeners["terminal-data"]?.({ sessionId, data } satisfies TerminalDataEvent);

    emit("\x1b[?");
    emit("25;47h");
    expect(store.getPreservedAlternateScreenMode(sessionId)).toBe(47);
    emit("\x1b[?104");
    emit("7;1049h");
    expect(store.getPreservedAlternateScreenMode(sessionId)).toBe(1049);
    emit("\x1b");
    emit("c");
    expect(store.getPreservedAlternateScreenMode(sessionId)).toBeNull();
    emit("\x1b[?" + "0;".repeat(512));
    emit("1049h");
    expect(store.getPreservedAlternateScreenMode(sessionId)).toBeNull();
    emit("\x1bc\x1b[?1047h");
    expect(store.getPreservedAlternateScreenMode(sessionId)).toBe(1047);
    emit("\x1b[?1047l");
    expect(store.getPreservedAlternateScreenMode(sessionId)).toBeNull();
  });

  test("derives a shell title from its cwd and gives a fixed title priority", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();
    const sessionId = "title";
    const { renderer, title } = makeRenderer();
    store.getOrCreateRenderer(sessionId, () => renderer);
    const attach = (cwd: string, fixedTitle: string | null = null) =>
      listeners["terminal-attached"]?.({
        sessionId,
        snapshot: makeSnapshot({ sessionId, cwd, title: fixedTitle }),
      } satisfies TerminalAttachedEvent);

    attach("/work/repo");
    title(" \x07repo — vim\x7f ");
    expect(store.resolveTitle(sessionId, "Terminal", 1)).toBe("vim");
    attach("/work/other");
    expect(store.resolveTitle(sessionId, "Terminal", 1)).toBe("repo — vim");
    attach("/work/repo", "Build");
    title("/work/repo");
    expect(store.resolveTitle(sessionId, "Terminal", 1)).toBe("Build");
    attach("/work/repo");
    expect(store.resolveTitle(sessionId, "Terminal", 1)).toBe("repo");
  });

  test("deduplicates fitted dimensions and forwards a same-size repaint", () => {
    const { calls, listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    store.ensureEventSubscriptions();
    const sessionId = "resize";
    const size = { cols: 90, rows: 25 };
    store.resize(sessionId, size);
    listeners["terminal-attached"]?.({ sessionId, snapshot: makeSnapshot({ sessionId }) });
    store.resize(sessionId, size);
    store.resize(sessionId, size);
    store.resize(sessionId, size, true);

    expect(calls).toEqual([
      ["terminal-resize", sessionId, size, false],
      ["terminal-resize", sessionId, size, true],
    ]);
  });

  test("notifies exit subscribers and removes renderer session state", () => {
    const { listeners } = installTerminalApiMock();
    const store = new TerminalSessionStore();
    const exitEvents: unknown[] = [];
    store.ensureEventSubscriptions();
    store.subscribeExit((event) => {
      exitEvents.push(event);
    });

    listeners["terminal-attached"]?.({
      sessionId: "session:one:terminal:5",
      snapshot: makeSnapshot({
        sessionId: "session:one:terminal:5",
        cwd: "/Users/asc/repo/nodex",
      }),
    } satisfies TerminalAttachedEvent);

    listeners["terminal-exit"]?.({
      sessionId: "session:one:terminal:5",
      exitCode: 0,
      reason: "exited",
    } satisfies TerminalExitEvent);

    expect(JSON.stringify(exitEvents)).toBe(
      JSON.stringify([{ sessionId: "session:one:terminal:5", exitCode: 0, reason: "exited" }]),
    );
    expect(store.resolveTitle("session:one:terminal:5", "Terminal", 5)).toBe("Terminal 5");
  });
});
