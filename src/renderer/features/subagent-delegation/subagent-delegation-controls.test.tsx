import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { TestQueryProvider } from "@/test/query";
import { SubagentDelegationConversationControl } from "./subagent-delegation-controls";

const runtime = vi.hoisted(() => {
  let chosen: boolean | null = null;
  return {
    delegation: vi.fn(async () => ({ subagentsMayDelegate: chosen })),
    setSubagentDelegation: vi.fn(
      async (input: { readonly subagentsMayDelegate: boolean | null }) => {
        chosen = input.subagentsMayDelegate;
        return { changed: true };
      },
    ),
  };
});
vi.mock("@/lib/agent-runtime-runtime", () => ({ agentRuntimeRuntime: runtime }));
vi.mock("@/lib/agent-runtime-settings", () => ({
  agentRuntimeSettingsQueryOptions: () => ({
    queryKey: ["settings", "agent-runtime"],
    queryFn: async () => ({ subagentsMayDelegate: true }),
  }),
  updateAgentRuntimeSettings: vi.fn(),
}));

it("keeps a chat's choice only while it differs from Settings", async () => {
  render(<SubagentDelegationConversationControl sessionId="session" />, {
    wrapper: TestQueryProvider,
  });
  const control = await screen.findByRole("switch", { name: "Let subagents delegate" });
  await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText("This chat")).toBeNull();

  await act(async () => {
    fireEvent.click(control);
    await Promise.resolve();
  });
  await screen.findByText("This chat");
  expect(runtime.setSubagentDelegation).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: "session", subagentsMayDelegate: false }),
  );
  expect(control.getAttribute("aria-checked")).toBe("false");

  // Back to the Settings answer, the chat follows Settings again instead of pinning it.
  await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(control);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByText("This chat")).toBeNull());
  expect(runtime.setSubagentDelegation).toHaveBeenLastCalledWith(
    expect.objectContaining({ subagentsMayDelegate: null }),
  );
  expect(control.getAttribute("aria-checked")).toBe("true");
});
