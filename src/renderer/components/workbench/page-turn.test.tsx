import { render } from "@/test/dom";
import { expect, test, vi } from "vite-plus/test";
import { REMOTE_AGENT_REASON } from "../../../shared/space-connection";
import { PageTurnView } from "./page-turn";
vi.mock("@/lib/renderer-space", () => ({ isRemoteSpace: () => true }));
vi.mock("@/lib/members-runtime", () => ({
  useMembers: () => ({ data: [] }),
  useLocalMember: () => ({ data: { id: "alice" } }),
}));
vi.mock("@/lib/use-agent-runtime-providers", () => ({
  useAgentRuntimeProviders: () => ({ data: [] }),
}));

test("explains why team Page work cannot start on this device", () => {
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
