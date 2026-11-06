import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { catalogModel } from "@/lib/agent-model-catalog.test-fixtures";
import { renderWithMaitai } from "@/test/thread-maitai";
import { DEFAULT_MODEL_POLICY, setModelOn } from "../../../../shared/model-policy";
import { AgentIntelligenceDropdown } from "./agent-intelligence-dropdown";

const CODEX = { instanceId: "codex", driver: "codex" };
vi.mock("@/features/model-policy/model-policy", () => ({
  useModelPolicy: () => ({
    settings: ["gpt-5.6-sol", "gpt-5.6-luna"].reduce(
      (policy, model) => setModelOn(policy, CODEX, model, false),
      DEFAULT_MODEL_POLICY,
    ),
  }),
}));
afterEach(cleanup);

const picker = (model: string) => (
  <NodexTooltipProvider delay={0}>
    <AgentIntelligenceDropdown
      open
      triggerStyle="settings"
      models={[
        catalogModel("gpt-6.1-sol", "GPT-6.1 Sol"),
        catalogModel("gpt-5.6-sol", "GPT-5.6 Sol"),
        catalogModel("gpt-5.6-luna", "GPT-5.6 Luna"),
      ]}
      selection={{ kind: "codex", model, reasoningEffort: "high", serviceTier: null }}
      onSelectionChange={() => {}}
    />
  </NodexTooltipProvider>
);

test("a plain model list leaves out what the person turned off, but keeps a saved choice", async () => {
  renderWithMaitai(
    <QueryClientProvider client={new QueryClient()}>{picker("gpt-5.6-luna")}</QueryClientProvider>,
  );
  await screen.findByRole("option", { name: /GPT-6\.1 Sol/u });
  expect(screen.getByRole("option", { name: /GPT-5\.6 Luna/u })).toBeDefined();
  expect(screen.queryByRole("option", { name: /GPT-5\.6 Sol/u })).toBeNull();
});

test("still opens on a surface outside the app's query owner", async () => {
  renderWithMaitai(picker("gpt-6.1-sol"));
  await screen.findByRole("option", { name: /GPT-5\.6 Sol/u });
});
