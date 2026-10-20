import { describe, expect, test } from "vite-plus/test";
import { act, render, screen } from "@testing-library/react";
import {
  createAgentRuntimeAgentLabelPort,
  createAgentRuntimeDelegatedTaskStore,
} from "../../agent-runtime-delegated-tasks";
import { ConversationRuntimeContext, type ConversationRuntime } from "../../conversation-runtime";
import { AgentHandoffDivider } from "./transcript-divider";

describe("Agent handoff divider", () => {
  test("names both Agents once their catalog loads and drops a source that is the target", async () => {
    const store = createAgentRuntimeDelegatedTaskStore();
    const runtime = {
      agentLabels: createAgentRuntimeAgentLabelPort(store),
    } as unknown as ConversationRuntime;
    const view = render(
      <ConversationRuntimeContext value={runtime}>
        <AgentHandoffDivider
          notice={{
            kind: "agentHandoff",
            from: [
              { providerInstanceId: "codex", model: "gpt" },
              { providerInstanceId: "claude", model: "sonnet" },
            ],
            to: { providerInstanceId: "claude", model: "sonnet" },
          }}
        />
      </ConversationRuntimeContext>,
    );
    const divider = view.container.querySelector('[data-runtime-notice="agentHandoff"]')!;
    expect(divider.textContent).toContain("Context handoff");
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
    expect(divider.textContent).toBe("Context handoff·Codex · GPT-5.5→toClaude · Sonnet");
  });
});
