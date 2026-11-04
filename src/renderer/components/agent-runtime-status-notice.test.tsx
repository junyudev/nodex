import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  __getNodexToastSnapshotForTests,
  __resetNodexToastStoreForTests,
} from "@/components/ui/toast";
import { render } from "@/test/dom";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";
import { AgentRuntimeStatusNotice } from "./agent-runtime-status-notice";

const runtime = vi.hoisted(() => ({
  connection: { status: "ready", generation: "one" } as AgentRuntimeConnectionState,
  restart: vi.fn<(input: { readonly generation: string }) => Promise<unknown>>(),
}));

vi.mock("@/lib/agent-runtime-session-activity", () => ({
  useAgentRuntimeConnectionState: () => runtime.connection,
}));
vi.mock("@/lib/agent-runtime-runtime", () => ({
  agentRuntimeRuntime: { restart: runtime.restart },
}));

const NAME = "Agent execution isn't responding";

describe("AgentRuntimeStatusNotice", () => {
  beforeEach(() => {
    __resetNodexToastStoreForTests();
    runtime.restart.mockReset();
    runtime.connection = { status: "unresponsive", generation: "one" };
  });

  test.each<AgentRuntimeConnectionState>([
    { status: "idle" },
    { status: "starting" },
    { status: "ready", generation: "one" },
    { status: "restarting", attempt: 1 },
    { status: "failed", message: "Could not start" },
  ])("stays silent while the process is $status", (connection) => {
    runtime.connection = connection;
    render(<AgentRuntimeStatusNotice />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("explains the wait and restarts only when asked", async () => {
    let finish: (value: unknown) => void = () => {};
    runtime.restart.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<AgentRuntimeStatusNotice />);

    expect(screen.getByRole("status").textContent).toContain(NAME);
    expect(runtime.restart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    const pending = screen.getByRole("button", { name: "Restarting…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(runtime.restart).toHaveBeenCalledExactlyOnceWith({ generation: "one" });

    finish({ restarted: true });
    await screen.findByRole("button", { name: "Restart" });
    expect(__getNodexToastSnapshotForTests()).toHaveLength(0);
  });

  test("reports a restart that fails and lets the person try again", async () => {
    runtime.restart.mockRejectedValue(
      new Error("Error invoking remote method 'agent-runtime:restart': Error: Could not start"),
    );
    render(<AgentRuntimeStatusNotice />);

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() =>
      expect(__getNodexToastSnapshotForTests()).toMatchObject([
        { title: "Agent execution could not restart", description: "Could not start" },
      ]),
    );
    await screen.findByRole("button", { name: "Restart" });
  });
});
