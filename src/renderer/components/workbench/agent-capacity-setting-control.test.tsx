import type { AgentRuntimeSettings } from "../../../shared/agent-runtime-settings";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { TestQueryProvider } from "@/test/query";
import { AgentCapacitySettingControl } from "./agent-capacity-setting-control";

const saved = vi.hoisted(() =>
  vi.fn(async (_client: unknown, input: AgentRuntimeSettings) => input),
);
vi.mock("@/lib/agent-runtime-settings", () => ({
  agentRuntimeSettingsQueryOptions: () => ({
    queryKey: ["settings", "agent-runtime"],
    queryFn: async () => ({ defaultRuntimeMode: "approval-required", automaticWorkAtOnce: 4 }),
  }),
  updateAgentRuntimeSettings: saved,
}));

it("saves machine capacity while retaining the permission choice", async () => {
  render(<AgentCapacitySettingControl />, { wrapper: TestQueryProvider });
  const input = await screen.findByRole("spinbutton", { name: "Automatic work at once" });
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(saved).toHaveBeenCalledWith(expect.anything(), {
      defaultRuntimeMode: "approval-required",
      automaticWorkAtOnce: 12,
    }),
  );
});
