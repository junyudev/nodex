import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { PageTurn } from "../../../../shared/page-turn";
import { REMOTE_AGENT_REASON } from "../../../../shared/space-connection";
import { renderWithQuery as render } from "@/test/query";
import { PageStatusTurn } from "./status-turn";
const state = vi.hoisted(() => ({
  reason: "ready_to_start" as PageTurn["reason"],
  actor: { kind: "member", member_id: "me" } as PageTurn["actor"],
  start: vi.fn(),
  accept: vi.fn(),
  hold: null as PageTurn["hold"],
  resume: vi.fn(),
  hostAvailable: true,
}));
vi.mock("@/lib/page-turn-runtime", () => ({
  usePageTurn: () => ({
    data: {
      turn: {
        page_id: "page",
        actor: state.actor,
        reason: state.reason,
        since: "now",
        episode: "episode",
        hold: state.hold,
      },
      activeChat: { session_id: "chat" },
    },
  }),
  acceptPageWork: state.accept,
}));
vi.mock("@/lib/work-graph-runtime", () => ({ startWork: state.start }));
vi.mock("@/lib/execution-holds-runtime", () => ({ setExecutionHold: state.resume }));
vi.mock("@/lib/space-host-runtime", () => ({
  useSpaceHostAvailable: () => state.hostAvailable,
}));
vi.mock("@/lib/members-runtime", () => ({
  useMembers: () => ({
    data: [
      { id: "me", display_name: "Alex" },
      { id: "alice", display_name: "Alice" },
    ],
  }),
  useLocalMember: () => ({ data: { id: "me" } }),
}));
vi.mock("@/lib/use-agent-runtime-providers", () => ({
  useAgentRuntimeProviders: () => ({ data: [] }),
}));
beforeEach(() => {
  state.reason = "ready_to_start";
  state.actor = { kind: "member", member_id: "me" };
  state.hold = null;
  state.hostAvailable = true;
  state.resume.mockReset().mockResolvedValue({});
  state.start.mockReset().mockResolvedValue({});
  state.accept.mockReset().mockResolvedValue({});
});
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
  });
};
test.each([
  [{ kind: "page", page_id: "page" }, "Resume"],
  [{ kind: "project", project_id: "project" }, "Resume Project"],
  [{ kind: "space" }, "Resume all work"],
] as const)("resumes Core's selected %s hold", async (scope, label) => {
  state.reason = "paused";
  state.hold = { scope, actor: "me", revision: 1, paused_at: "now" };
  render(<PageStatusTurn pageId="page" />);
  expect(screen.getByText("Paused", { exact: true })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
  await click(label);
  await waitFor(() => expect(state.resume).toHaveBeenCalledWith(scope, false));
});
test("ready work says so and starts with one action, never naming a Turn", async () => {
  const view = render(<PageStatusTurn pageId="page" />);
  expect(screen.getByText("Ready to start")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Start" })).toHaveLength(1);
  expect(view.container.textContent).not.toMatch(/Turn/u);
  await click("Start");
  await waitFor(() => expect(state.start).toHaveBeenCalledWith({ pageId: "page", again: false }));
});
test("Start explains why this device cannot run the work", () => {
  state.hostAvailable = false;
  render(<PageStatusTurn pageId="page" />);
  expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText(REMOTE_AGENT_REASON)).toBeTruthy();
});
test("review acceptance uses the Page work acceptance command", async () => {
  state.reason = "review";
  render(<PageStatusTurn pageId="page" />);
  expect(screen.getByText("Ready for your review")).toBeTruthy();
  await click("Accept");
  await waitFor(() => expect(state.accept).toHaveBeenCalledWith("page"));
});
test("another person's move names them and offers no action", () => {
  state.reason = "question";
  state.actor = { kind: "member", member_id: "alice" };
  render(<PageStatusTurn pageId="page" />);
  expect(screen.getByText("Waiting for Alice’s answer")).toBeTruthy();
});
test("a prerequisite is a link to its Page", async () => {
  state.reason = "waiting_on_prerequisite";
  state.actor = { kind: "page", page_id: "prerequisite", key: "NODEX-2" };
  const open = vi.fn();
  render(<PageStatusTurn pageId="page" onOpenPage={open} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "Waiting for NODEX-2" }));
    await Promise.resolve();
  });
  expect(open).toHaveBeenCalledWith("prerequisite");
  expect(screen.queryByRole("button")).toBeNull();
});
test.each(["question", "approval", "blocked", "failed", "stalled", "working"] as const)(
  "opens the active chat for %s",
  async (reason) => {
    state.reason = reason;
    const open = vi.fn();
    render(<PageStatusTurn pageId="page" onOpenChat={open} />);
    await click("Open chat");
    expect(open).toHaveBeenCalledWith("chat");
  },
);
