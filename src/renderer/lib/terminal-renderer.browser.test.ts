import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { expect, test, vi } from "vite-plus/test";
import type { Terminal } from "@xterm/xterm";
import type { TerminalCreateRequest } from "../../shared/types";
import { handleKey } from "./terminal-keyboard";
import { TerminalRenderer } from "./terminal-renderer";
import { terminalSessionStore, TERMINAL_RENDERER_BUFFER_LIMIT } from "./terminal-session-store";
import { useTerminal } from "./use-terminal";

import "@xterm/xterm/css/xterm.css";

function openRenderer() {
  const host = document.createElement("div");
  document.body.append(host);
  const renderer = new TerminalRenderer({});
  renderer.terminal.open(host);
  return {
    renderer,
    dispose() {
      renderer.dispose();
      host.remove();
    },
  };
}

function write(term: Terminal, data: string) {
  return new Promise<void>((done) => term.write(data, done));
}

test("keeps the cursor column across a bare PTY line feed", async () => {
  const { renderer, dispose } = openRenderer();
  try {
    renderer.replaceOutput("\x1b[3;10HX\nY");
    await renderer.ready;
    const buffer = renderer.terminal.buffer.active;
    expect(buffer.getLine(2)?.getCell(9)?.getChars()).toBe("X");
    expect(buffer.getLine(3)?.getCell(10)?.getChars()).toBe("Y");
  } finally {
    dispose();
  }
});

test("reports a rebuilt display once, after the replay that superseded another has parsed", async () => {
  const { renderer, dispose } = openRenderer();
  try {
    const buffer = renderer.terminal.buffer;
    const replayed: (string | undefined)[] = [];
    const finished = new Promise<void>((done) => {
      renderer.onReplay = () => {
        const active = buffer.active;
        replayed.push(active.getLine(active.baseY + active.cursorY)?.translateToString(true));
        done();
      };
    });
    renderer.replaceOutput("local tail");
    renderer.replaceOutput(Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"));
    await finished;
    await renderer.ready;
    expect(replayed).toEqual(["line 199"]);
  } finally {
    dispose();
  }
});

test("clipboard paste passes through xterm's bracketed paste mode", async () => {
  const { renderer, dispose } = openRenderer();
  try {
    const term = renderer.terminal;
    await write(term, "\x1b[?2004h");
    const outgoing = vi.fn();
    term.onData(outgoing);
    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, cancelable: true });
    expect(
      handleKey({
        event,
        term,
        platform: "win32",
        clipboard: { readText: async () => "one\ntwo", writeText: async () => {} },
        onPaste: () => true,
        clearSession: () => {},
        sendText: () => {},
      }),
    ).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    await expect.poll(() => outgoing.mock.calls).toEqual([["\x1b[200~one\rtwo\x1b[201~"]]);
  } finally {
    dispose();
  }
});

function installTerminalApi(replay?: string) {
  const calls: unknown[][] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const api = window.api;
  window.api = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push([channel, ...args]);
      if (channel !== "terminal-create") return;
      const { sessionId, size } = args[0] as TerminalCreateRequest;
      const snapshot = {
        ...terminalSessionStore.getSnapshot(sessionId),
        viewLease: { windowSessionId: "window", generation: 1, size },
      };
      if (replay !== undefined)
        listeners.get("terminal-init-log")?.({ sessionId, data: replay, snapshot });
      listeners.get("terminal-attached")?.({ sessionId, snapshot });
      return { status: "acquired", generation: 1, snapshot };
    },
    on: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, callback);
      return () => {
        listeners.delete(event);
      };
    },
  };
  return {
    calls,
    emit: (event: string, payload: unknown) => listeners.get(event)?.(payload),
    restore() {
      terminalSessionStore.disposeEventSubscriptions();
      window.api = api;
    },
  };
}

function TerminalTestView({ sessionId }: { sessionId: string }) {
  const { containerRef } = useTerminal({ terminalId: sessionId, cwd: "/work" });
  return createElement("div", { ref: containerRef, style: { width: "640px", height: "360px" } });
}

function mountedRenderer(sessionId: string) {
  return terminalSessionStore.getOrCreateRenderer(sessionId, () => {
    throw new Error("Expected the view to own the renderer");
  });
}

test("fences generated replies during replay while forwarding keyboard input", async () => {
  const sessionId = "query-replay";
  const api = installTerminalApi();
  const view = render(createElement(TerminalTestView, { sessionId }));
  let resume: (handled: boolean) => void = () => {};

  try {
    await act(async () => {
      await expect
        .poll(() => api.calls.some(([channel]) => channel === "terminal-create"))
        .toBe(true);
    });
    const renderer = mountedRenderer(sessionId);
    const term = renderer.terminal;
    const parsedInput = vi.fn();
    term.onData(parsedInput);
    let notifyParserPaused = () => {};
    const parserPaused = new Promise<void>((resolve) => {
      notifyParserPaused = resolve;
    });
    term.parser.registerCsiHandler(
      { final: "n" },
      () =>
        new Promise<boolean>((resolve) => {
          resume = resolve;
          notifyParserPaused();
        }),
    );

    await act(async () => {
      api.emit("terminal-init-log", {
        sessionId,
        data: "\x1b[6n\x1b[c",
        snapshot: terminalSessionStore.getSnapshot(sessionId),
      });
      await parserPaused;
      expect(renderer.isReplayingInitLog).toBe(true);
      term.textarea?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      resume(false);
      await renderer.ready;
    });

    expect(parsedInput.mock.calls).toEqual([
      ["\r"],
      ["\x1b[1;1R"],
      [expect.stringMatching(/^\x1b\[\?/)],
    ]);
    expect(api.calls.filter(([channel]) => channel === "terminal-write")).toEqual([
      ["terminal-write", sessionId, "\r"],
    ]);
  } finally {
    resume(false);
    view.unmount();
    api.restore();
  }
});

test("restores a clipped alternate buffer and requests a same-size repaint on attach", async () => {
  const sessionId = "alternate-tail";
  const tail = "x".repeat(TERMINAL_RENDERER_BUFFER_LIMIT);
  const api = installTerminalApi(tail);
  terminalSessionStore.ensureEventSubscriptions();
  api.emit("terminal-data", { sessionId, data: "\x1b[?1049h" + tail });
  terminalSessionStore.release(sessionId);
  const view = render(createElement(TerminalTestView, { sessionId }));

  try {
    const renderer = mountedRenderer(sessionId);
    await act(async () => {
      await expect
        .poll(() =>
          api.calls.some(
            ([channel, , , repaint]) => channel === "terminal-resize" && repaint === true,
          ),
        )
        .toBe(true);
      await renderer.ready;
    });
    const create = api.calls.find(([channel]) => channel === "terminal-create");
    const size = (create?.[1] as TerminalCreateRequest).size;
    expect(api.calls).toContainEqual(["terminal-resize", sessionId, size, true]);
    expect(renderer.terminal.buffer.active.type).toBe("alternate");
    expect(terminalSessionStore.getSnapshot(sessionId).buffer).not.toContain("\x1b[?1049h");
  } finally {
    view.unmount();
    api.restore();
  }
});
