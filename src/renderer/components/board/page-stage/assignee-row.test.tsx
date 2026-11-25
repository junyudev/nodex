import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import { inboxAgentsFixture } from "@/features/inbox/inbox-agents.test-support";
import { InboxAgentPicker } from "@/features/inbox/inbox-agent-picker";
import { PageAssigneeRow } from "./assignee-row";
const state = vi.hoisted(() => ({
  start: vi.fn(),
  reload: vi.fn(),
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
  useInboxAgents: () => inboxAgentsFixture({ reload: state.reload }),
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
  state.reload.mockClear();
  state.members = [
    { id: "person", library_id: "library", display_name: "You", lifecycle: "active", revision: 1 },
  ];
});
test("the Assignee picker opens once on mount, reloads, and returns focus to its trigger", async () => {
  const onChange = vi.fn();
  const view = render(<PageAssigneeRow pageWork={work} onChange={onChange} openOnMount />);
  const trigger = screen.getByRole("button", { name: "Choose Assignee" });
  const search = await screen.findByRole("combobox", { name: "Search models" });
  expect(screen.getByRole("option", { name: "You" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(state.reload).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.keyDown(search, { key: "Escape" });
  });
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  view.rerender(<PageAssigneeRow pageWork={{ ...work }} onChange={onChange} openOnMount />);
  await settleAsyncRender();
  expect(screen.queryByRole("listbox")).toBeNull();
  view.rerender(<PageAssigneeRow pageWork={null} onChange={onChange} openOnMount />);
  view.rerender(<PageAssigneeRow pageWork={work} onChange={onChange} openOnMount />);
  await settleAsyncRender();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(state.reload).toHaveBeenCalledTimes(1);
});
test("a disabled Inbox Agent picker ignores the mount request after enabling", async () => {
  const agents = inboxAgentsFixture();
  const props = {
    agents,
    purpose: "chat",
    scope: "inbox",
    value: agents.settings.chatAgent,
    onChange: vi.fn(),
    trigger: "field",
  } as const;
  const view = render(<InboxAgentPicker {...props} openOnMount disabled />);
  expect(screen.queryByRole("listbox")).toBeNull();
  view.rerender(<InboxAgentPicker {...props} openOnMount />);
  await settleAsyncRender();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(agents.reload).not.toHaveBeenCalled();
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
