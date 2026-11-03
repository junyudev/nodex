import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { TerminalSessionSnapshot } from "../../../shared/types";
import type { TerminalStoreEvent } from "@/lib/terminal-session-store";
import type { ProcessOutputPanelTab } from "@/lib/workbench-panel-tab-model";
import { ProcessOutputPanelTabView } from "./workbench-runtime-panel-surfaces";

const terminal = vi.hoisted(() => ({
  snapshots: new Map<string, TerminalSessionSnapshot>(),
  listeners: new Map<string, (event: TerminalStoreEvent) => void>(),
  fetchSnapshot: vi.fn<(sessionId: string) => Promise<TerminalSessionSnapshot | null>>(),
}));
vi.mock("@/lib/terminal-session-store", () => ({
  terminalSessionStore: {
    getSnapshot: (sessionId: string) => terminal.snapshots.get(sessionId),
    ensureEventSubscriptions: () => {},
    fetchSnapshot: terminal.fetchSnapshot,
    subscribe: (sessionId: string, listener: (event: TerminalStoreEvent) => void) => {
      terminal.listeners.set(sessionId, listener);
      return () => terminal.listeners.delete(sessionId);
    },
  },
}));
vi.mock("@/features/local-conversation", () => ({ useConversation: () => null }));
vi.mock("@/components/ui/lazy-source-viewer", () => ({
  LazySourceViewer: ({ value }: { value: string }) => <div role="log">{value}</div>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  NodexTooltip: ({ children }: { children: ReactNode }) => children,
}));

function snapshot(sessionId: string, buffer: string): TerminalSessionSnapshot {
  return {
    sessionId,
    conversationId: null,
    projectSessionId: null,
    osPid: null,
    cpuPercent: null,
    rssKb: null,
    childProcessCount: null,
    processMetricsSampledAtMs: null,
    cwd: `/repo/${sessionId}`,
    shell: null,
    title: null,
    backendKind: "local",
    buffer,
    truncated: false,
    exited: false,
    exitCode: null,
    viewLease: null,
  };
}
function tab(terminalSessionId: string | null): ProcessOutputPanelTab {
  return {
    processOutputPanel: true,
    id: "output",
    sessionId: "session",
    projectId: null,
    panelId: "right",
    threadId: "thread",
    turnId: null,
    itemId: "command",
    title: "Output",
    stateKey: 0,
    command: "build",
    cwd: null,
    terminalSessionId,
  };
}

beforeEach(() => {
  terminal.snapshots.clear();
  terminal.listeners.clear();
  terminal.fetchSnapshot.mockReset().mockResolvedValue(null);
});

test("switches terminal sources and ignores the previous source's pending fetch", async () => {
  terminal.snapshots.set("first", snapshot("first", "First output"));
  terminal.snapshots.set("second", snapshot("second", "Second output"));
  let resolveFirst!: (value: TerminalSessionSnapshot) => void;
  terminal.fetchSnapshot.mockImplementation((id) =>
    id === "first"
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve(null),
  );
  const view = render(<ProcessOutputPanelTabView tab={tab("first")} />);
  expect(screen.getByRole("log").textContent).toBe("First output");
  view.rerender(<ProcessOutputPanelTabView tab={tab("second")} />);
  expect(screen.getByRole("log").textContent).toBe("Second output");
  expect(terminal.listeners.has("first")).toBe(false);
  await act(async () => {
    resolveFirst(snapshot("first", "Late first output"));
    await Promise.resolve();
  });
  expect(screen.getByRole("log").textContent).toBe("Second output");
  view.rerender(<ProcessOutputPanelTabView tab={tab(null)} />);
  expect(screen.queryByRole("log")).toBeNull();
});

test("keeps the final output after the terminal record is released on exit", async () => {
  terminal.snapshots.set("first", snapshot("first", "Initial"));
  const view = render(<ProcessOutputPanelTabView tab={tab("first")} />);
  await act(async () => {
    terminal.snapshots.set("first", snapshot("first", "Final output"));
    terminal.listeners.get("first")?.({ type: "data", sessionId: "first", data: "Final output" });
    terminal.listeners.get("first")?.({
      type: "exit",
      sessionId: "first",
      exitCode: 0,
      reason: "exited",
    });
    terminal.snapshots.delete("first");
    await Promise.resolve();
  });
  view.rerender(<ProcessOutputPanelTabView tab={{ ...tab("first"), title: "Finished" }} />);
  expect(screen.getByRole("log").textContent).toBe("Final output");
  view.unmount();
  expect(terminal.listeners.size).toBe(0);
});
