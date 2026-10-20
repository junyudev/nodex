import { describe, expect, test } from "vite-plus/test";
import { act, render, screen } from "@testing-library/react";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import {
  createAgentRuntimeAgentLabelPort,
  createAgentRuntimeDelegatedTaskStore,
} from "../../agent-runtime-delegated-tasks";
import { ConversationRuntimeContext, type ConversationRuntime } from "../../conversation-runtime";
import { AgentHandoffDivider } from "./transcript-divider";

const notice = {
  kind: "agentHandoff" as const,
  carried: "conversation" as const,
  failed: false,
  from: [
    { providerInstanceId: "codex", model: "gpt" },
    { providerInstanceId: "claude", model: "sonnet" },
  ],
  to: { providerInstanceId: "claude", model: "sonnet" },
};

function setup(value: Parameters<typeof AgentHandoffDivider>[0]["notice"]) {
  const store = createAgentRuntimeDelegatedTaskStore();
  const runtime = {
    agentLabels: createAgentRuntimeAgentLabelPort(store),
  } as unknown as ConversationRuntime;
  const view = render(
    <NodexTooltipProvider>
      <ConversationRuntimeContext value={runtime}>
        <AgentHandoffDivider notice={value} />
      </ConversationRuntimeContext>
    </NodexTooltipProvider>,
  );
  return {
    store,
    divider: () => view.container.querySelector('[data-runtime-notice="agentHandoff"]')!,
  };
}

describe("Agent handoff divider", () => {
  test("names both Agents once their catalog loads and drops a source that is the target", async () => {
    const { store, divider } = setup(notice);
    expect(divider().textContent).toContain("Context handoff");
    await act(async () => {
      store.publishLabels(
        new Map([
          ["codex", { label: "Codex", kind: "codex", models: new Map([["gpt", "GPT-5.5"]]) }],
          ["claude", { label: "Claude", kind: "claude", models: new Map([["sonnet", "Sonnet"]]) }],
        ]),
      );
      await Promise.resolve();
    });
    expect(screen.getByText("Codex · GPT-5.5")).toBeTruthy();
    expect(screen.getAllByText("Claude · Sonnet")).toHaveLength(1);
    expect(divider().textContent).toContain("Context handoff·Codex · GPT-5.5→toClaude · Sonnet");
    expect(divider().textContent).toContain("Carried the conversation so far.");
  });

  test("says what a merged fork carried and when a handoff failed", () => {
    const merged = setup({ ...notice, carried: "fork" });
    expect(merged.divider().textContent).toContain("Fork merged back");
    expect(merged.divider().textContent).toContain("Carried the fork's work");
    const failed = setup({ ...notice, carried: "missed", failed: true });
    expect(failed.divider().textContent).toContain("Context handoff failed");
    expect(failed.divider().textContent).toContain("may not have the earlier conversation");
  });
});
