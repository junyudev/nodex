import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { codexProvider } from "@/features/inbox/inbox-agents.test-support";
import { render, settleAsyncRender } from "@/test/dom";
import { WritingModelSettingRow } from "./writing-model-setting-row";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/agent-runtime-settings", () => {
  const queryKey = ["settings", "agent-runtime"];
  return {
    agentRuntimeSettingsQueryOptions: () => ({ queryKey, queryFn: () => mocks.query() }),
    updateAgentRuntimeSettings: async (
      client: { setQueryData: (key: readonly string[], value: unknown) => void },
      input: unknown,
    ) => {
      client.setQueryData(queryKey, await mocks.invoke(input));
    },
  };
});
vi.mock("@/lib/use-agent-runtime-providers", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useAgentRuntimeProviders: () =>
      useQuery({ queryKey: ["providers"], queryFn: async () => [codexProvider()] }),
    useRefreshAgentRuntimeProviders: () => () => {},
  };
});
vi.mock("@/features/local-conversation/use-agent-instances", () => ({
  useAgentInstances: () => ({ instances: [] }),
}));

const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await settleAsyncRender();
  });
};

const renderRow = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WritingModelSettingRow />
    </QueryClientProvider>,
  );

describe("Writing model", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.query.mockReset();
  });

  test("saves an exact model and can return to Automatic", async () => {
    mocks.query.mockResolvedValue({ defaultRuntimeMode: "auto", writingModel: null });
    mocks.invoke.mockImplementation(async ({ writingModel }: { writingModel: unknown }) => ({
      defaultRuntimeMode: "auto",
      writingModel,
    }));
    renderRow();

    const trigger = screen.getByRole("button", { name: "Writing model" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    expect(trigger.textContent).toBe("Automatic");

    await click(trigger);
    // Effort and speed are Nodex's to decide here, so the menu lists models and nothing else.
    expect(screen.queryByRole("slider", { name: "Effort" })).toBeNull();
    await click(screen.getByRole("option", { name: /GPT-6 Luna/ }));
    expect(mocks.invoke).toHaveBeenLastCalledWith({
      writingModel: { instanceId: "codex", model: "gpt-6-luna" },
    });
    await waitFor(() => expect(trigger.textContent).toBe("GPT-6 Luna"));

    await click(trigger);
    await click(screen.getByRole("option", { name: "Automatic" }));
    expect(mocks.invoke).toHaveBeenLastCalledWith({ writingModel: null });
    await waitFor(() => expect(trigger.textContent).toBe("Automatic"));
  });
});
