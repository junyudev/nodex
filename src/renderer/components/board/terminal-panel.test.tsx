import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { render } from "../../test/dom";

let useTerminalCalls: unknown[] = [];
let terminalHookResult = {
  containerRef: { current: null },
  isUnavailable: true,
  error: null as string | null,
  leaseConflict: null as {
    generation: number;
    ownerWindowSessionId: string;
  } | null,
  reconnect: vi.fn(),
  takeOver: vi.fn(),
  kill: vi.fn(),
};

vi.mock("@/lib/use-terminal", () => ({
  useTerminal: (options: unknown) => {
    useTerminalCalls.push(options);
    return terminalHookResult;
  },
}));

describe("TerminalPanel", () => {
  beforeEach(() => {
    useTerminalCalls = [];
    terminalHookResult = {
      containerRef: { current: null },
      isUnavailable: true,
      error: null,
      leaseConflict: null,
      reconnect: vi.fn(),
      takeOver: vi.fn(),
      kill: vi.fn(),
    };
  });

  test("renders the terminal surface without the redundant session header row", async () => {
    const { TerminalPanel } = await import("./terminal-panel");
    const { queryByText, getByText } = render(
      <TerminalPanel terminalId="terminal-test" cwd="/Users/asc/repo/nodex" />,
    );

    const terminalRoot = document.querySelector("[data-codex-terminal='true']");
    expect(terminalRoot instanceof HTMLElement).toBe(true);
    expect(terminalRoot?.getAttribute("data-codex-xterm")).toBe("true");
    expect(queryByText("Session Terminal")).toBe(null);
    expect(getByText("Terminal requires the Electron desktop app").textContent).toBe(
      "Terminal requires the Electron desktop app",
    );
  });

  test("passes a normalized cwd into the terminal hook", async () => {
    const { TerminalPanel } = await import("./terminal-panel");
    render(
      <TerminalPanel
        terminalId="terminal-test"
        cwd="  /Users/asc/repo/nodex  "
        conversationId="thread-1"
        projectSessionId="session-1"
      />,
    );

    expect(JSON.stringify(useTerminalCalls[0])).toBe(
      JSON.stringify({
        terminalId: "terminal-test",
        cwd: "/Users/asc/repo/nodex",
        conversationId: "thread-1",
        projectSessionId: "session-1",
      }),
    );
  });

  test("blocks blank cwd instead of attaching a PTY with its process default", async () => {
    const { TerminalPanel } = await import("./terminal-panel");
    render(<TerminalPanel terminalId="terminal-test" cwd="   " />);

    expect(useTerminalCalls).toHaveLength(0);
    expect(document.body.textContent).toContain("Terminal workspace is unavailable");
  });

  test("offers explicit takeover and kill actions when another window owns the lease", async () => {
    terminalHookResult = {
      ...terminalHookResult,
      isUnavailable: false,
      leaseConflict: {
        generation: 4,
        ownerWindowSessionId: "window-session-other",
      },
    };
    const { TerminalPanel } = await import("./terminal-panel");
    const view = render(<TerminalPanel terminalId="terminal-test" cwd="/Users/asc/repo/nodex" />);

    expect(view.getByText("Active in another window")).toBeTruthy();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Take over" }));
      fireEvent.click(view.getByRole("button", { name: "Kill terminal" }));
      await Promise.resolve();
    });

    expect(terminalHookResult.takeOver).toHaveBeenCalledOnce();
    expect(terminalHookResult.kill).toHaveBeenCalledOnce();
  });
});
