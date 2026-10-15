import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../test/dom";
import type { ProjectAgentDockModel } from "@/lib/project-agent-dock-model";
import { createAgentRuntimeActivityStore } from "@/lib/agent-runtime-session-activity";
import type {
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityChange,
} from "../../../shared/agent-runtime-api";
import { ProjectAgentDockTargetSelector } from "./project-agent-dock-target-selector";

const newRow = {
  id: "new",
  kind: "new",
  sessionId: null,
  runtimeSessionId: null,
  label: "New chat",
  preview: null,
  selected: true,
  attention: "none",
  indicator: "idle",
} as const;
const runningRow = {
  id: "session:running",
  kind: "session",
  sessionId: "running",
  runtimeSessionId: null,
  label: "Refine board",
  preview: "Updating the project database",
  selected: false,
  attention: "activity",
  indicator: "running",
} as const;
const unreadRow = {
  id: "session:unread",
  kind: "session",
  sessionId: "unread",
  runtimeSessionId: null,
  label: "Review notes",
  preview: "A new response is ready",
  selected: false,
  attention: "none",
  indicator: "unread",
} as const;

function makeModel(overrides: Partial<ProjectAgentDockModel> = {}): ProjectAgentDockModel {
  return {
    trigger: newRow,
    rows: [newRow, runningRow, unreadRow],
    canSend: true,
    collectionMessage: null,
    hasMore: false,
    ...overrides,
  };
}

describe("ProjectAgentDockTargetSelector", () => {
  test("selects the active keyboard row and returns focus to the trigger", async () => {
    const onSelect = vi.fn();
    const view = render(
      <ProjectAgentDockTargetSelector
        model={makeModel()}
        query=""
        onQueryChange={() => undefined}
        onSelect={onSelect}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
      />,
    );
    const trigger = view.getByLabelText("Connected chat: New chat");
    await act(async () => {
      fireEvent.click(trigger);
    });
    const input = await view.findByRole("combobox", {
      name: "Choose connected chat",
    });
    await waitFor(() => expect(document.activeElement).toBe(input));

    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onSelect).toHaveBeenCalledWith(runningRow);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("does not refocus the search input when result rows refresh", async () => {
    const renderSelector = (model: ProjectAgentDockModel) => (
      <ProjectAgentDockTargetSelector
        model={model}
        query=""
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
      />
    );
    const view = render(renderSelector(makeModel({ hasMore: true })));
    await act(async () => {
      fireEvent.click(view.getByLabelText("Connected chat: New chat"));
    });
    const input = await view.findByRole("combobox", {
      name: "Choose connected chat",
    });
    await waitFor(() => expect(document.activeElement).toBe(input));
    const loadMore = view.getByRole("button", { name: "Load more" });
    loadMore.focus();

    view.rerender(
      renderSelector(
        makeModel({
          rows: [newRow, unreadRow, runningRow],
          hasMore: true,
        }),
      ),
    );

    await waitFor(() => expect(document.activeElement).toBe(loadMore));
  });

  test("uses the leading indicator for running and unread state without status copy", async () => {
    const view = render(
      <ProjectAgentDockTargetSelector
        model={makeModel()}
        query=""
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByLabelText("Connected chat: New chat"));
    });
    const listbox = await view.findByRole("listbox", { name: "Project chats" });
    const runningOption = within(listbox).getByRole("option", {
      name: /Running, Refine board/,
    });
    const unreadOption = within(listbox).getByRole("option", {
      name: /Unread, Review notes/,
    });

    expect(within(runningOption).getByLabelText("Running")).not.toBeNull();
    expect(within(unreadOption).getByLabelText("Unread")).not.toBeNull();
    expect(within(listbox).queryByText("Draft")).toBeNull();
    expect(within(listbox).queryByText("Running")).toBeNull();
    expect(view.getByPlaceholderText("Find a chat")).not.toBeNull();
  });

  test("keeps loading, retry, and pagination actions inside the picker", async () => {
    const onRetry = vi.fn();
    const onLoadMore = vi.fn();
    const view = render(
      <ProjectAgentDockTargetSelector
        model={makeModel({
          collectionMessage: "Couldn’t load chats",
          hasMore: true,
        })}
        query=""
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onLoadMore={onLoadMore}
        onRetry={onRetry}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByLabelText("Connected chat: New chat"));
    });
    const listbox = await view.findByRole("listbox", {
      name: "Project chats",
    });
    await act(async () => {
      fireEvent.click(within(listbox).getByRole("button", { name: "Retry" }));
      fireEvent.click(within(listbox).getByRole("button", { name: "Load more" }));
    });
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  test("updates a Runtime chat's indicator from its own Session activity", async () => {
    const listeners = new Set<(change: AgentRuntimeSessionActivityChange) => void>();
    const store = createAgentRuntimeActivityStore({
      read: async () => ({ sequence: 0, items: [], complete: true }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      readConnection: async () => ({ status: "ready", generation: "g1" }),
      subscribeConnection: () => () => {},
    });
    const runtimeRow = {
      ...unreadRow,
      id: "session:runtime",
      sessionId: "runtime",
      runtimeSessionId: "runtime",
      label: "Delegate review",
      indicator: "idle",
    } as const;
    const activity = (
      status: AgentRuntimeSessionActivity["status"],
    ): AgentRuntimeSessionActivity => ({
      sessionId: "runtime",
      threadId: "root-1",
      status,
      activeRunId: null,
      pendingRequestCount: status === "waiting" ? 1 : 0,
      activeTaskCount: status === "background" ? 1 : 0,
      resumesAutomatically: status === "background",
      providerInstanceId: "claude",
      model: "claude-sonnet",
      updatedAt: "2026-10-15T00:00:00.000Z",
    });
    const view = render(
      <ProjectAgentDockTargetSelector
        model={makeModel({ trigger: runtimeRow, rows: [newRow, runtimeRow] })}
        query=""
        onQueryChange={() => undefined}
        onSelect={() => undefined}
        onLoadMore={() => undefined}
        onRetry={() => undefined}
        activityStore={store}
      />,
    );
    expect(await view.findByLabelText("Connected chat: Delegate review")).not.toBeNull();
    const push = async (change: AgentRuntimeSessionActivityChange) => {
      await act(async () => {
        for (const listener of listeners) listener(change);
        await Promise.resolve();
      });
    };
    await push({ type: "upsert", sequence: 1, activity: activity("background") });
    expect(
      await view.findByLabelText("Connected chat: Delegate review, Working in background"),
    ).not.toBeNull();
    await push({ type: "upsert", sequence: 2, activity: activity("waiting") });
    expect(
      await view.findByLabelText("Connected chat: Delegate review, Needs attention"),
    ).not.toBeNull();
    await push({ type: "remove", sequence: 3, sessionId: "runtime" });
    expect(await view.findByLabelText("Connected chat: Delegate review")).not.toBeNull();
  });
});
