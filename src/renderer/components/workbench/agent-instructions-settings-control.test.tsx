import type { AgentRuntimeSettings } from "../../../shared/agent-runtime-settings";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { TestQueryProvider } from "@/test/query";
import { StandingInstructionsRow } from "./agent-instructions-settings-control";

const saved = vi.hoisted(() =>
  vi.fn(async (_client: unknown, input: AgentRuntimeSettings) => input),
);
vi.mock("@/lib/agent-runtime-settings", () => ({
  agentRuntimeSettingsQueryOptions: () => ({
    queryKey: ["settings", "agent-runtime"],
    queryFn: async () => ({
      defaultRuntimeMode: "approval-required",
      automaticWorkAtOnce: 4,
      titleModel: null,
      instructions: { artifactOpening: "ask-first", standingInstructions: "Keep replies short." },
    }),
  }),
  updateAgentRuntimeSettings: saved,
}));

async function openStandingInstructions() {
  render(<StandingInstructionsRow />, { wrapper: TestQueryProvider });
  const toggle = await screen.findByRole("button", { name: /Your instructions/ });
  await act(async () => {
    fireEvent.click(toggle);
    await Promise.resolve();
  });
  return (await screen.findByRole("textbox", { name: "Your instructions" })) as HTMLTextAreaElement;
}

it("saves edited standing instructions while keeping the artifact preference", async () => {
  const field = await openStandingInstructions();
  await waitFor(() => expect(field.disabled).toBe(false));
  await act(async () => {
    fireEvent.change(field, { target: { value: "Write the test first." } });
    fireEvent.blur(field);
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(saved).toHaveBeenCalledWith(expect.anything(), {
      defaultRuntimeMode: "approval-required",
      automaticWorkAtOnce: 4,
      titleModel: null,
      instructions: {
        artifactOpening: "ask-first",
        standingInstructions: "Write the test first.",
      },
    }),
  );
});

it("does not save when the field loses focus unchanged", async () => {
  saved.mockClear();
  const field = await openStandingInstructions();
  await waitFor(() => expect(field.disabled).toBe(false));
  await act(async () => {
    fireEvent.blur(field);
    await Promise.resolve();
  });
  expect(saved).not.toHaveBeenCalled();
});
