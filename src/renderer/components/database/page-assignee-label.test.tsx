import { expect, test, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import { renderWithQuery as render } from "@/test/query";
import { PageAssigneeLabel } from "./page-assignee-label";
import { PageTurnView } from "../workbench/page-turn";
vi.mock("@/lib/members-runtime", () => ({
  useMembers: () => ({
    data: [
      { id: "me", display_name: "Alex" },
      { id: "other", display_name: "Sam" },
    ],
  }),
  useLocalMember: () => ({ data: { id: "me" } }),
}));
vi.mock("@/lib/use-agent-runtime-providers", () => ({
  useAgentRuntimeProviders: () => ({
    data: [
      {
        instanceId: "codex",
        displayName: "Codex",
        driver: "codex",
        models: [
          {
            slug: "raw-model-id",
            name: "GPT-5.5",
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  type: "select",
                  label: "Effort",
                  options: [{ id: "medium", label: "Medium" }],
                },
              ],
            },
          },
        ],
      },
    ],
  }),
}));
test("an Agent assignment is named by its catalog model, leaving effort to the picker", () => {
  render(
    <PageAssigneeLabel
      assignee={{ kind: "agent", instance_id: "codex", model: "raw-model-id", effort: "medium" }}
    />,
  );
  expect(screen.getByText("GPT-5.5")).toBeTruthy();
  expect(screen.queryByText(/Medium/u)).toBeNull();
});
test.each([
  ["me", "Ready for your review"],
  ["other", "Ready for Sam’s review"],
])("a turn names Member %s relative to the reader", (member_id, phrase) => {
  render(
    <PageTurnView
      turn={{
        page_id: "page",
        actor: { kind: "member", member_id },
        reason: "review",
        since: "now",
        episode: "episode",
      }}
    />,
  );
  expect(screen.getByText(phrase)).toBeTruthy();
});
test("a turn uses the Agent provider name", () => {
  render(
    <PageTurnView
      turn={{
        page_id: "page",
        actor: {
          kind: "agent",
          assignee: { kind: "agent", instance_id: "codex", model: "raw-model-id" },
        },
        reason: "working",
        since: "now",
        episode: "episode",
      }}
    />,
  );
  expect(screen.getByText("Codex is working")).toBeTruthy();
});
