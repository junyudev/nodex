import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import { inboxAgentsFixture } from "@/features/inbox/inbox-agents.test-support";
import { PageAssigneeRow, PageOwnerRow } from "./assignee-row";
const state = vi.hoisted(() => ({
  start: vi.fn(),
  members: [
    { id: "person", library_id: "library", display_name: "You", lifecycle: "active", revision: 1 },
  ],
}));
vi.mock("@/lib/work-graph-runtime", () => ({ startWork: state.start }));
vi.mock("@/lib/members-runtime", () => ({ useMembers: () => ({ data: state.members }) }));
vi.mock("@/lib/use-agent-runtime-providers", () => ({
  useAgentRuntimeProviders: () => ({ data: inboxAgentsFixture().providers }),
}));
vi.mock("@/features/inbox/inbox-agent-picker", async (original) => ({
  ...(await original<typeof import("@/features/inbox/inbox-agent-picker")>()),
  useInboxAgents: () => inboxAgentsFixture(),
}));
const work = {
  owner: "person",
  assignee: { kind: "agent", instance_id: "codex", model: "gpt-6-astra", effort: "medium" },
  auto_start: false,
} as const;
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await settleAsyncRender();
  });
};
beforeEach(() => {
  state.start.mockReset().mockResolvedValue({});
  state.members = [
    { id: "person", library_id: "library", display_name: "You", lifecycle: "active", revision: 1 },
  ];
});
test("one picker chooses a person and clears Agent consent", async () => {
  const onChange = vi.fn();
  render(<PageAssigneeRow pageWork={{ ...work, auto_start: true }} onChange={onChange} />);
  await click(screen.getByRole("button", { name: "Choose Assignee" }));
  await click(await screen.findByRole("option", { name: "You" }));
  expect(onChange).toHaveBeenLastCalledWith({
    ...work,
    assignee: { kind: "member", member_id: "person" },
    auto_start: false,
  });
});
test("only Agent assignments offer Start automatically, inside the Assignee menu", async () => {
  const onChange = vi.fn();
  const view = render(<PageAssigneeRow pageWork={work} onChange={onChange} />);
  expect(screen.queryByText("Auto-start")).toBeNull();
  expect(screen.getByRole("button", { name: "Choose Assignee" }).textContent).not.toMatch(
    /Medium/u,
  );
  await click(screen.getByRole("button", { name: "Choose Assignee" }));
  const toggle = await screen.findByRole("switch", { name: "Start automatically" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  expect(onChange).toHaveBeenCalledWith({ ...work, auto_start: true });
  view.rerender(<PageAssigneeRow pageWork={{ ...work, auto_start: true }} onChange={onChange} />);
  expect(screen.getByText("Auto-start")).toBeTruthy();
  view.rerender(
    <PageAssigneeRow
      pageWork={{ ...work, assignee: { kind: "member", member_id: "person" } }}
      onChange={onChange}
    />,
  );
  expect(screen.queryByRole("switch", { name: "Start automatically" })).toBeNull();
  expect(screen.queryByText("Auto-start")).toBeNull();
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
});
test("Owner stays hidden in a personal Library and becomes editable with more people", async () => {
  const onChange = vi.fn();
  const view = render(<PageOwnerRow pageWork={work} onChange={onChange} />);
  expect(screen.queryByRole("button", { name: "Choose Owner" })).toBeNull();
  view.unmount();
  state.members = [
    ...state.members,
    { id: "other", library_id: "library", display_name: "Alex", lifecycle: "active", revision: 1 },
  ];
  render(<PageOwnerRow pageWork={work} onChange={onChange} />);
  await click(screen.getByRole("button", { name: "Choose Owner" }));
  await click(await screen.findByRole("menuitem", { name: "Alex" }));
  expect(onChange).toHaveBeenCalledWith({ ...work, owner: "other" });
});
