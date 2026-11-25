import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  registerTerminalFocusTarget,
  rememberFocusBeforeTerminal,
  requestTerminalFocus,
  returnFocusFromPanel,
  terminalHoldsFocus,
} from "./terminal-focus";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { createElement } from "react";
import type { Terminal, ITheme } from "@xterm/xterm";
import type { TerminalCreateRequest } from "../../shared/types";
import { handleKey } from "./terminal-keyboard";
import { TerminalRenderer } from "./terminal-renderer";
import { terminalSessionStore, TERMINAL_RENDERER_BUFFER_LIMIT } from "./terminal-session-store";
import { useTerminal } from "./use-terminal";
import "@xterm/xterm/css/xterm.css";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import { applyTerminalTheme } from "./terminal-appearance";
import "@/globals.css";
import { userEvent } from "vite-plus/test/browser";
import AgentAuthTerminal from "../features/agent-account/agent-auth-terminal";

describe("terminal focus", () => {
  const nextFrame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

  const terminal = (terminalSessionId: string) => ({
    kind: "terminal",
    config: { terminalSessionId },
  });

  function appendTerminalTab(terminalId: string): HTMLTextAreaElement {
    const surface = document.createElement("div");
    surface.id = `terminal-panel-${terminalId}`;
    surface.dataset.codexTerminal = "true";
    const input = document.createElement("textarea");
    surface.append(input);
    bottomPanel().append(surface);
    return input;
  }

  function bottomPanel(): HTMLElement {
    const existing = document.querySelector<HTMLElement>(
      '[data-app-shell-focus-area="bottom-panel"]',
    );
    if (existing) return existing;
    const panel = document.createElement("section");
    panel.dataset.appShellFocusArea = "bottom-panel";
    document.body.append(panel);
    return panel;
  }

  function appendComposer(parent: HTMLElement = document.body): HTMLElement {
    const composer = document.createElement("div");
    composer.contentEditable = "true";
    composer.dataset.codexComposer = "true";
    composer.textContent = "draft";
    parent.append(composer);
    return composer;
  }

  const unregisterTargets: (() => void)[] = [];

  /** Mounts a Terminal the way its view does, returning how many times it was asked to focus. */
  function mountTerminal(terminalId: string): { readonly focus: ReturnType<typeof vi.fn> } {
    const focus = vi.fn();
    unregisterTargets.push(registerTerminalFocusTarget(terminalId, focus));
    return { focus };
  }

  afterEach(() => {
    vi.useRealTimers();
    // Ends any request a test left waiting and forgets what the cursor left.
    returnFocusFromPanel("bottom");
    for (const unregister of unregisterTargets.splice(0)) unregister();
    document.body.replaceChildren();
  });

  describe("requestTerminalFocus", () => {
    test("focuses a Terminal that is already mounted", () => {
      const { focus } = mountTerminal("terminal-a");

      requestTerminalFocus(terminal("terminal-a"));

      expect(focus).toHaveBeenCalledTimes(1);
    });

    test("waits for the Terminal to mount, then answers once", () => {
      requestTerminalFocus(terminal("terminal-a"));

      const first = mountTerminal("terminal-a");
      expect(first.focus).toHaveBeenCalledTimes(1);

      // The same Terminal mounting again later, such as on a Scene switch, was not asked for.
      const second = mountTerminal("terminal-a");
      expect(second.focus).not.toHaveBeenCalled();
    });

    test("another Terminal mounting does not answer the request", () => {
      requestTerminalFocus(terminal("terminal-a"));

      expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
      expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);
    });

    test("ignores a surface that is not a Terminal", () => {
      requestTerminalFocus(terminal("terminal-a"));
      requestTerminalFocus({ kind: "browser", config: { terminalSessionId: "terminal-b" } });
      requestTerminalFocus(null);

      expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
      expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);
    });

    test("a pointer press while waiting keeps the cursor where the user put it", () => {
      requestTerminalFocus(terminal("terminal-a"));

      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

      expect(mountTerminal("terminal-a").focus).not.toHaveBeenCalled();
    });

    test("a newer request replaces the one still waiting", () => {
      requestTerminalFocus(terminal("terminal-a"));
      requestTerminalFocus(terminal("terminal-b"));

      expect(mountTerminal("terminal-a").focus).not.toHaveBeenCalled();
      expect(mountTerminal("terminal-b").focus).toHaveBeenCalledTimes(1);
    });

    test("a request expires rather than moving the cursor long after it was made", () => {
      vi.useFakeTimers();
      requestTerminalFocus(terminal("terminal-a"));
      vi.advanceTimersByTime(999);
      expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);

      requestTerminalFocus(terminal("terminal-b"));
      vi.advanceTimersByTime(1_000);
      expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
    });

    test("an open dialog keeps the cursor", () => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const search = document.createElement("input");
      dialog.append(search);
      document.body.append(dialog);
      search.focus();
      const mounted = mountTerminal("terminal-a");

      requestTerminalFocus(terminal("terminal-a"));
      expect(mounted.focus).not.toHaveBeenCalled();

      requestTerminalFocus(terminal("terminal-b"));
      expect(mountTerminal("terminal-b").focus).not.toHaveBeenCalled();
    });

    test("a Terminal that has unmounted waits for its next mount", () => {
      const stale = vi.fn();
      registerTerminalFocusTarget("terminal-a", stale)();

      requestTerminalFocus(terminal("terminal-a"));

      expect(stale).not.toHaveBeenCalled();
      expect(mountTerminal("terminal-a").focus).toHaveBeenCalledTimes(1);
    });
  });

  describe("returnFocusFromPanel", () => {
    test("hiding the Terminal returns to the editor the cursor came from", async () => {
      appendComposer();
      const editor = document.createElement("input");
      document.body.append(editor);
      const input = appendTerminalTab("terminal-a");
      editor.focus();
      rememberFocusBeforeTerminal(editor);
      input.focus();

      returnFocusFromPanel("bottom");
      await nextFrame();

      expect(document.activeElement).toBe(editor);
    });

    test("falls back to the composer when the previous editor is gone", async () => {
      const composer = appendComposer();
      const editor = document.createElement("input");
      document.body.append(editor);
      const input = appendTerminalTab("terminal-a");
      rememberFocusBeforeTerminal(editor);
      editor.remove();
      input.focus();

      returnFocusFromPanel("bottom");
      await nextFrame();

      expect(document.activeElement).toBe(composer);
    });

    test("skips a composer the Scene has hidden", async () => {
      const hiddenSection = document.createElement("section");
      hiddenSection.setAttribute("aria-hidden", "true");
      document.body.append(hiddenSection);
      appendComposer(hiddenSection);
      const composer = appendComposer();
      appendTerminalTab("terminal-a").focus();

      returnFocusFromPanel("bottom");
      await nextFrame();

      expect(document.activeElement).toBe(composer);
    });

    test("a cursor outside the hiding panel stays put", async () => {
      appendComposer();
      const editor = document.createElement("input");
      document.body.append(editor);
      appendTerminalTab("terminal-a");
      editor.focus();

      returnFocusFromPanel("bottom");
      await nextFrame();

      expect(document.activeElement).toBe(editor);
    });

    test("a cursor resting on the page moves to the composer", async () => {
      const composer = appendComposer();

      returnFocusFromPanel("bottom");
      await nextFrame();

      expect(document.activeElement).toBe(composer);
    });

    test("cancels a Terminal focus still waiting to mount", async () => {
      const composer = appendComposer();
      requestTerminalFocus(terminal("terminal-a"));

      returnFocusFromPanel("bottom");
      await nextFrame();

      expect(mountTerminal("terminal-a").focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(composer);
    });
  });

  describe("rememberFocusBeforeTerminal", () => {
    test("ignores controls and other Terminals, which are no place to return to", async () => {
      const composer = appendComposer();
      const button = document.createElement("button");
      button.textContent = "Toggle";
      document.body.append(button);
      const other = appendTerminalTab("terminal-b");
      const input = appendTerminalTab("terminal-a");

      rememberFocusBeforeTerminal(button);
      rememberFocusBeforeTerminal(other);
      rememberFocusBeforeTerminal(null);
      input.focus();
      returnFocusFromPanel("bottom");
      await nextFrame();

      expect(document.activeElement).toBe(composer);
    });
  });

  describe("terminalHoldsFocus", () => {
    test("reports only the Terminal the cursor is inside", () => {
      const input = appendTerminalTab("terminal-a");
      appendTerminalTab("terminal-b");
      input.focus();

      expect(terminalHoldsFocus("terminal-a")).toBe(true);
      expect(terminalHoldsFocus("terminal-b")).toBe(false);
      expect(terminalHoldsFocus("terminal-missing")).toBe(false);
    });
  });
});

describe("terminal renderer", () => {
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
      renderer.replaceOutput(
        Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\r\n"),
      );
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

  test("the bottom panel toggle reaches the application menu instead of the shell", () => {
    const { renderer, dispose } = openRenderer();
    try {
      const term = renderer.terminal;
      const outgoing = vi.fn();
      term.onData(outgoing);
      const press = (isBottomPanelToggle: (event: KeyboardEvent) => boolean) => {
        term.attachCustomKeyEventHandler((event) =>
          handleKey({
            event,
            term,
            platform: "linux",
            isBottomPanelToggle,
            onPaste: () => true,
            clearSession: () => {},
            sendText: () => {},
          }),
        );
        const event = new KeyboardEvent("keydown", {
          key: "j",
          keyCode: 74,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        term.textarea?.dispatchEvent(event);
        return event;
      };

      const toggled = press((event) => event.ctrlKey && event.key === "j");
      expect(toggled.defaultPrevented).toBe(false);
      expect(outgoing).not.toHaveBeenCalled();

      // Any other binding leaves Ctrl+J to the shell as a newline.
      const typed = press(() => false);
      expect(typed.defaultPrevented).toBe(true);
      expect(outgoing).toHaveBeenCalledWith("\n");
    } finally {
      dispose();
    }
  });

  test("a focus request reaches the xterm input when its view mounts", async () => {
    const sessionId = "focus-request";
    installTerminalApi();
    requestTerminalFocus({ kind: "terminal", config: { terminalSessionId: sessionId } });
    const view = renderTerminalTestView(sessionId);
    try {
      expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(true);
      (document.activeElement as HTMLElement).blur();

      // Already mounted, the same request moves the cursor straight away.
      requestTerminalFocus({ kind: "terminal", config: { terminalSessionId: sessionId } });
      expect(document.activeElement?.classList.contains("xterm-helper-textarea")).toBe(true);
    } finally {
      view.unmount();
      terminalSessionStore.release(sessionId);
    }
  });

  function renderTerminalTestView(sessionId: string) {
    return render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TerminalTestView, { sessionId }),
      ),
    );
  }

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
    const view = renderTerminalTestView(sessionId);
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
    const view = renderTerminalTestView(sessionId);

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
});

describe("terminal theme", () => {
  installRendererThemeFixture();

  const tokens = {
    background: "background",
    foreground: "foreground",
    cursor: "foreground",
    selectionBackground: "selection",
    selectionInactiveBackground: "selection-inactive",
    black: "ansi-black",
    red: "ansi-red",
    green: "ansi-green",
    yellow: "ansi-yellow",
    blue: "ansi-blue",
    magenta: "ansi-magenta",
    cyan: "ansi-cyan",
    white: "ansi-white",
    brightBlack: "ansi-bright-black",
    brightRed: "ansi-bright-red",
    brightGreen: "ansi-bright-green",
    brightYellow: "ansi-bright-yellow",
    brightBlue: "ansi-bright-blue",
    brightMagenta: "ansi-bright-magenta",
    brightCyan: "ansi-bright-cyan",
    brightWhite: "ansi-bright-white",
  } satisfies Partial<Record<keyof ITheme, string>>;

  test("applies the computed terminal tokens across light, dark, and light appearances", async () => {
    const surface = document.createElement("div");
    surface.dataset.codexTerminal = "true";
    surface.className = "terminal-fallback-surface";
    document.body.append(surface);
    const renderer = new TerminalRenderer({});
    const term = renderer.terminal;

    try {
      term.open(surface);
      renderer.replaceOutput("\x1b[31mR");
      await renderer.ready;

      const palettes: ITheme[] = [];
      for (const variant of ["light", "dark", "light"] as const) {
        applyRendererThemeForTest(variant);
        applyTerminalTheme(term, surface);
        const theme = term.options.theme ?? {};
        for (const [role, token] of Object.entries(tokens)) {
          expect(theme[role as keyof typeof tokens], role).toBe(
            readRendererThemeColor(`--color-codex-terminal-${token}`),
          );
        }
        await expect.poll(() => readCellColor(surface, "R")).toBe(theme.red);
        palettes.push(theme);
      }

      expect(palettes[1]).not.toEqual(palettes[0]);
      expect(palettes[2]).toEqual(palettes[0]);
    } finally {
      renderer.dispose();
      surface.remove();
    }
  });

  function readCellColor(surface: HTMLElement, glyph: string): string | undefined {
    const cell = Array.from(surface.querySelectorAll(".xterm-rows span")).find(
      (element) => element.textContent === glyph,
    );
    return cell ? getComputedStyle(cell).color : undefined;
  }

  test("paints indexed SGR with the resolved modern CSS color and truecolor with the SGR value", async () => {
    const surface = document.createElement("div");
    surface.style.setProperty(
      "--color-codex-terminal-ansi-red",
      "color-mix(in srgb, rgb(40 80 120), rgb(80 120 160))",
    );
    document.body.append(surface);
    const expected = document.createElement("span");
    expected.style.color = "var(--color-codex-terminal-ansi-red)";
    surface.append(expected);
    const indexedColor = getComputedStyle(expected).color;
    expected.remove();
    const renderer = new TerminalRenderer({});
    const term = renderer.terminal;

    try {
      term.open(surface);
      applyTerminalTheme(term, surface);
      renderer.replaceOutput("\x1b[38;5;1mI\x1b[38;2;12;98;207mT");
      await renderer.ready;

      await expect.poll(() => readCellColor(surface, "I")).toBe(indexedColor);
      expect(readCellColor(surface, "T")).toBe("rgb(12, 98, 207)");
    } finally {
      renderer.dispose();
      surface.remove();
    }
  });
});

describe("agent auth terminal", () => {
  test("shows the sign-in command's output as it grows and sends what is typed to it", async () => {
    const onInput = vi.fn<(data: string) => void>();
    const onResize = vi.fn<(size: { cols: number; rows: number }) => void>();
    const ports = { onInput, onResize };
    const view = render(<AgentAuthTerminal output="Code: " outputOffset={6} {...ports} />);
    const shown = () =>
      view.getByRole("group", { name: "Sign-in terminal" }).querySelector(".xterm-rows")
        ?.textContent ?? "";
    try {
      await expect.poll(shown).toContain("Code:");
      // The command's PTY takes the size the terminal fits to.
      const [size] = onResize.mock.calls.at(-1)!;
      expect(size.cols).toBeGreaterThan(0);
      expect(size.rows).toBeGreaterThan(0);

      // Output after what the terminal already shows is appended.
      view.rerender(
        <AgentAuthTerminal output={"Code: ABCD\r\nWaiting"} outputOffset={19} {...ports} />,
      );
      await expect.poll(shown).toContain("Waiting");
      expect(shown()).toContain("Code: ABCD");

      // A gap the Runtime no longer holds redraws the terminal from the output it kept.
      view.rerender(<AgentAuthTerminal output="Signed in" outputOffset={120} {...ports} />);
      await expect.poll(shown).toContain("Signed in");
      expect(shown()).not.toContain("Waiting");

      await userEvent.keyboard("y");
      await expect.poll(() => onInput.mock.calls).toEqual([["y"]]);
    } finally {
      view.unmount();
    }
  });
});
