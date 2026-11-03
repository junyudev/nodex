import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentWindowsSandboxState } from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { ComposerNoticeRail } from "./view/composer/composer-notice-rail";
import { useWindowsSandboxSetup } from "./use-windows-sandbox-setup";

const needed: AgentWindowsSandboxState = {
  generation: "endpoint:1",
  status: "notConfigured",
  mode: null,
  failure: null,
  allowedModes: ["elevated", "unelevated"],
};

function Harness() {
  const notice = useWindowsSandboxSetup("codex");
  return notice ? <ComposerNoticeRail notice={notice} placement="attached" /> : null;
}

function mount() {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NodexTooltipProvider>
        <Harness />
      </NodexTooltipProvider>
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Windows setup in the Agent problem notice", () => {
  it("asks for administrator approval and clears only after the owner reports readiness", async () => {
    let state = needed;
    vi.spyOn(agentRuntimeRuntime, "readWindowsSandbox").mockImplementation(async () => state);
    const setup = vi
      .spyOn(agentRuntimeRuntime, "setupWindowsSandbox")
      .mockImplementation(async ({ mode }) => ({
        ...needed,
        generation: "endpoint:2",
        status: "settingUp",
        mode,
      }));
    const client = mount();
    const admin = await screen.findByRole("button", { name: "Set up" });
    expect(setup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Set up without admin" })).toBeNull();
    await act(async () => {
      admin.click();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Cancel" });
    expect(setup).toHaveBeenCalledExactlyOnceWith({ instanceId: "codex", mode: "elevated" });
    state = { ...needed, status: "ready" };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["agent-windows-sandbox", "codex"] });
    });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    client.clear();
  });

  it("cancels the observed attempt and offers working without admin as an explicit fallback", async () => {
    vi.spyOn(agentRuntimeRuntime, "readWindowsSandbox").mockResolvedValue(needed);
    const setup = vi
      .spyOn(agentRuntimeRuntime, "setupWindowsSandbox")
      .mockImplementation(async ({ mode }) => ({
        ...needed,
        generation: mode === "elevated" ? "endpoint:4" : "endpoint:6",
        status: "settingUp",
        mode,
      }));
    const cancel = vi.spyOn(agentRuntimeRuntime, "cancelWindowsSandbox").mockResolvedValue({
      ...needed,
      generation: "endpoint:5",
      status: "failed",
      failure: "cancelled",
    });
    const client = mount();
    const setUp = await screen.findByRole("button", { name: "Set up" });
    await act(async () => {
      setUp.click();
      await Promise.resolve();
    });
    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    await act(async () => {
      cancelButton.click();
      await Promise.resolve();
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith({
      instanceId: "codex",
      generation: "endpoint:4",
    });
    await screen.findByRole("button", { name: "Try again" });
    const withoutAdmin = await screen.findByRole("button", { name: "Set up without admin" });
    await act(async () => {
      withoutAdmin.click();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Cancel" });
    expect(setup.mock.calls.map(([request]) => request.mode)).toEqual(["elevated", "unelevated"]);
    client.clear();
  });
});
