import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, test, expect, vi, beforeEach } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexDropdownMenu } from "@/components/ui/dropdown";
import { openNodexMenu } from "@/test/dom";
import type { ExecutionHold } from "../../../shared/work-application";
import { PageExecutionHoldItem, SpaceExecutionHoldControl } from "./execution-hold-controls";
import { useComposerExecutionHold } from "@/features/local-conversation/view/composer/use-composer-execution-hold";
const state = vi.hoisted(() => ({
  holds: [] as ExecutionHold[],
  queries: [] as string[],
  writes: [] as { scope: ExecutionHold["scope"]; paused: boolean }[],
}));
vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokeRendererQuery: async (channel: string) => {
    state.queries.push(channel);
    return state.holds;
  },
  invokeLocalCommitCommand: async (
    _command: unknown,
    input: { scope: ExecutionHold["scope"]; paused: boolean },
  ) => {
    state.writes.push(input);
    state.holds = input.paused
      ? [{ scope: input.scope, actor: "person", revision: 1, paused_at: "today" }]
      : state.holds.filter((h) => JSON.stringify(h.scope) !== JSON.stringify(input.scope));
  },
}));
const wrap = (ui: React.ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NodexTooltipProvider>{ui}</NodexTooltipProvider>
    </QueryClientProvider>,
  );
};
beforeEach(() => {
  state.holds = [];
  state.queries = [];
  state.writes = [];
});
describe("execution hold controls", () => {
  test("the Inbox pauses all work and offers a quiet Resume action", async () => {
    wrap(<SpaceExecutionHoldControl />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause all Agent work" }));
      await Promise.resolve();
    });
    const resume = await screen.findByRole("button", { name: "Paused · Resume" });
    expect(state.writes[0]).toMatchObject({ scope: { kind: "space" }, paused: true });
    await act(async () => {
      fireEvent.click(resume);
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Pause all Agent work" });
    expect(state.writes[1]).toMatchObject({ scope: { kind: "space" }, paused: false });
  });
  test("the Page action changes only its own hold", async () => {
    state.holds = [
      {
        scope: { kind: "project", project_id: "project" },
        actor: "person",
        revision: 1,
        paused_at: "today",
      },
    ];
    wrap(
      <NodexDropdownMenu triggerButton={<button>Page actions</button>}>
        <PageExecutionHoldItem pageId="page" />
      </NodexDropdownMenu>,
    );
    await openNodexMenu(screen.getByRole("button", { name: "Page actions" }));
    const pause = await screen.findByRole("menuitem", { name: "Pause work" });
    await act(async () => {
      fireEvent.click(pause);
      await Promise.resolve();
    });
    expect(state.writes[0]).toMatchObject({
      scope: { kind: "page", page_id: "page" },
      paused: true,
    });
  });
  test("Composer resume names a parent scope and never implicitly clears it", async () => {
    state.holds = [
      {
        scope: { kind: "page", page_id: "page" },
        actor: "person",
        revision: 1,
        paused_at: "today",
      },
      {
        scope: { kind: "project", project_id: "project" },
        actor: "person",
        revision: 2,
        paused_at: "today",
      },
    ];
    function Composer() {
      const hold = useComposerExecutionHold({ kind: "session", sessionId: "session" });
      return (
        <>
          <button disabled={hold.held}>Send</button>
          {hold.notice?.actions?.map((action) => (
            <button key={action.label} onClick={() => void action.run()}>
              {action.label}
            </button>
          ))}
        </>
      );
    }
    wrap(<Composer />);
    const resume = await screen.findByRole("button", { name: "Resume Project" });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.writes).toEqual([]);
    await act(async () => {
      fireEvent.click(resume);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(state.writes[0]).toMatchObject({
        scope: { kind: "project", project_id: "project" },
        paused: false,
      }),
    );
    await screen.findByRole("button", { name: "Resume to send" });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });
  test("a chat that has not started is held only by its Space or Project", async () => {
    const hold = (scope: ExecutionHold["scope"]): ExecutionHold => ({
      scope,
      actor: "person",
      revision: 1,
      paused_at: "today",
    });
    state.holds = [
      hold({ kind: "page", page_id: "page" }),
      hold({ kind: "project", project_id: "other" }),
    ];
    function NewChat({ projectId }: { readonly projectId: string }) {
      const held = useComposerExecutionHold({ kind: "new_chat", projectId });
      return <span>{held.notice?.actions?.[0]?.label ?? "Ready"}</span>;
    }
    const view = wrap(<NewChat projectId="project" />);
    await waitFor(() => expect(state.queries).toContain("work:holds"));
    expect(await screen.findByText("Ready")).toBeTruthy();
    view.unmount();
    state.holds = [...state.holds, hold({ kind: "project", project_id: "project" })];
    wrap(<NewChat projectId="project" />);
    expect(await screen.findByText("Resume Project")).toBeTruthy();
    // Its Session does not exist until the first send, so nothing asks Core about it.
    expect(state.queries).not.toContain("work:effective-hold");
  });
});
