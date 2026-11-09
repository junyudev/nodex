import { render } from "@/test/dom";
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { expect, test, vi } from "vite-plus/test";
import { REMOTE_AGENT_REASON } from "../../../shared/space-connection";
import { PageTurnView } from "./page-turn";
vi.mock("@/lib/renderer-space", () => ({ isRemoteSpace: () => true }));
const host = vi.hoisted(() => ({ available: false }));
vi.mock("@/lib/space-host-runtime", () => ({ useSpaceHostAvailable: () => host.available }));
vi.mock("@/lib/members-runtime", () => ({
  useMembers: () => ({ data: [] }),
  useLocalMember: () => ({ data: { id: "alice" } }),
}));
vi.mock("@/lib/use-agent-runtime-providers", () => ({
  useAgentRuntimeProviders: () => ({ data: [] }),
}));

test("explains why team Page work cannot start on this device", () => {
  host.available = false;
  const start = vi.fn();
  const view = render(
    <PageTurnView
      turn={{
        page_id: "page",
        actor: { kind: "member", member_id: "alice" },
        reason: "ready_to_start",
        since: "now",
        episode: "episode",
      }}
      onStart={start}
    />,
  );
  expect((view.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByLabelText(REMOTE_AGENT_REASON)).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
});

test("a team Page starts on its available host", async () => {
  host.available = true;
  const start = vi.fn();
  const view = render(
    <PageTurnView
      turn={{
        page_id: "page",
        actor: { kind: "member", member_id: "alice" },
        reason: "ready_to_start",
        since: "now",
        episode: "episode",
      }}
      onStart={start}
    />,
  );
  const button = view.getByRole("button", { name: "Start" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(view.queryByLabelText(REMOTE_AGENT_REASON)).toBeNull();
});
