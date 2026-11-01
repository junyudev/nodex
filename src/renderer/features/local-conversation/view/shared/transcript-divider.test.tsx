import { describe, expect, test } from "vite-plus/test";
import { act, render, screen } from "@testing-library/react";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import { agentRuntimeDelegatedTasks } from "../../agent-runtime-delegated-tasks";
import { AgentHandoffDivider } from "./transcript-divider";

const notice = {
  kind: "agentHandoff" as const,
  carried: "conversation" as const,
  failed: false,
  from: [
    { providerInstanceId: "handoff-codex", model: "gpt" },
    { providerInstanceId: "handoff-claude", model: "sonnet" },
  ],
  to: { providerInstanceId: "handoff-claude", model: "sonnet" },
};

function setup(value: Parameters<typeof AgentHandoffDivider>[0]["notice"]) {
  const view = render(
    <NodexTooltipProvider>
      <AgentHandoffDivider notice={value} />
    </NodexTooltipProvider>,
  );
  return {
    divider: () => view.container.querySelector('[data-runtime-notice="agentHandoff"]')!,
  };
}

describe("Agent handoff divider", () => {
  test("marks both Agents and names their models once the catalog loads", async () => {
    const { divider } = setup(notice);
    expect(divider().textContent).toContain("Context handoff");
    await act(async () => {
      agentRuntimeDelegatedTasks.publishLabels(
        new Map([
          [
            "handoff-codex",
            { label: "Codex", kind: "codex", models: new Map([["gpt", "GPT-6.1-Sol"]]) },
          ],
          [
            "handoff-claude",
            { label: "Claude Code", kind: "claude", models: new Map([["sonnet", "Sonnet 5.5"]]) },
          ],
        ]),
      );
      await Promise.resolve();
    });
    expect(screen.getByText("GPT-6.1 Sol")).toBeTruthy();
    expect(screen.getAllByText("Sonnet 5.5")).toHaveLength(1);
    expect(
      [...divider().querySelectorAll("[data-agent-identity]")].map((agent) =>
        agent.getAttribute("data-agent-identity"),
      ),
    ).toEqual(["codex", "claude"]);
    // Assistive text names each Agent in full.
    expect(divider().textContent).toContain("Codex · GPT-6.1 Sol");
    expect(divider().textContent).toContain("Claude Code · Sonnet 5.5");
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
