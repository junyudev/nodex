import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import { DEFAULT_INBOX_SETTINGS, type InboxChat } from "../../../shared/inbox";
import { readInboxChatTargets, readInboxSettings, updateInboxSettings } from "@/lib/inbox-runtime";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { agentRuntimeProvidersQueryOptions } from "@/lib/use-agent-runtime-providers";
import { InboxDispatchEditor, draftFromAction } from "./inbox-dispatch-editor";
import { InboxSettingsPage } from "./inbox-settings-page";

vi.mock("@/lib/inbox-runtime", () => ({
  readInboxChatTargets: vi.fn(),
  readInboxSettings: vi.fn(),
  updateInboxSettings: vi.fn(),
}));

const { agentSettingsListeners } = vi.hoisted(() => ({
  agentSettingsListeners: new Set<() => void>(),
}));
vi.mock("@/lib/agent-runtime-runtime", () => ({ agentRuntimeRuntime: { catalog: vi.fn() } }));
vi.mock("@/lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({
    subscribeAgentSettingsChanges: (listener: () => void) => {
      agentSettingsListeners.add(listener);
      return () => agentSettingsListeners.delete(listener);
    },
  }),
}));

const renderQuery = (
  children: ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) => render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
const click = async (name: string, role = "button") => {
  await act(async () => {
    fireEvent.click(screen.getByRole(role, { name }));
    await settleAsyncRender();
  });
};

const chat = (sessionId: string, displayTitle: string): InboxChat => ({
  sessionId,
  displayTitle,
  projectId: "project:A",
  projectName: "Alpha",
  threadId: null,
  executionRef: null,
  status: null,
  unread: false,
  archived: false,
});
const provider = (
  instanceId: string,
  driver: Awaited<ReturnType<typeof agentRuntimeRuntime.catalog>>[number]["driver"],
  displayName: string,
): Awaited<ReturnType<typeof agentRuntimeRuntime.catalog>>[number] => ({
  instanceId,
  driver,
  displayName,
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-18T00:00:00.000Z",
  models: [
    {
      slug: "precise-model",
      name: "Precise model",
      isCustom: false,
      isDefault: true,
      capabilities: {},
    },
  ],
  slashCommands: [],
  skills: [],
});

const deferredCatalog = () => {
  let resolve!: (providers: Awaited<ReturnType<typeof agentRuntimeRuntime.catalog>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof agentRuntimeRuntime.catalog>>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  agentSettingsListeners.clear();
  vi.mocked(readInboxSettings).mockResolvedValue(DEFAULT_INBOX_SETTINGS);
  vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([]);
  vi.mocked(readInboxChatTargets).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(updateInboxSettings).mockImplementation(async (input) => ({
    ...DEFAULT_INBOX_SETTINGS,
    ...input,
  }));
});

describe("Inbox destination and Agent selection", () => {
  test("a new decision retains the canonical chat title before opening search", () => {
    renderQuery(
      <InboxDispatchEditor
        initial={{
          ...draftFromAction(
            { type: "send_to_chat", sessionId: "session:old", prompt: "Continue" },
            "Continue",
          ),
          chat: chat("session:old", "Earlier research"),
        }}
        projects={[]}
        onSubmit={vi.fn(async () => true)}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Earlier research")).toBeTruthy();
    expect(readInboxChatTargets).not.toHaveBeenCalled();
  });

  test("searches the owning scope before pagination and keeps a selected older chat visible", async () => {
    vi.mocked(readInboxChatTargets).mockImplementation(async (input) => ({
      items:
        input.query === "old research"
          ? [chat("session:old", "Research findings")]
          : [chat("session:new", "Today")],
      nextCursor: null,
    }));
    const onSubmit = vi.fn(async () => true);
    renderQuery(
      <InboxDispatchEditor
        initial={draftFromAction(
          { type: "send_to_chat", sessionId: "session:new", prompt: "Continue" },
          "Continue",
        )}
        projects={[]}
        inboxProjectId="project:A"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await click("Chat");
    await screen.findByRole("option", { name: /Today/ });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Search chats" }), {
        target: { value: "old research" },
      });
      await Promise.resolve();
    });
    const option = await screen.findByRole("option", { name: /Research findings/ });
    expect(readInboxChatTargets).toHaveBeenLastCalledWith({
      scope: { kind: "project", projectId: "project:A" },
      query: "old research",
      first: 50,
      after: null,
    });
    await act(async () => {
      fireEvent.click(option);
      await settleAsyncRender();
    });
    expect(screen.getByRole("button", { name: "Chat" }).textContent).toContain("Research findings");
    await click("Send");
    // The chosen chat travels with the action, so the message can say where it went.
    expect(onSubmit).toHaveBeenCalledWith(
      { type: "send_to_chat", sessionId: "session:old", prompt: "Continue" },
      expect.objectContaining({ sessionId: "session:old", displayTitle: "Research findings" }),
    );
  });

  test("keeps an unavailable selected Agent and model explicit, and selects real catalog IDs", async () => {
    vi.mocked(readInboxSettings).mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      suggestionAgent: { instanceId: "removed:account" },
      suggestionModel: "retired-model",
    });
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([
      provider("claude:work", "claudeAgent", "Work Claude"),
      provider("other:work", "opencode", "Work OpenCode"),
    ]);
    renderQuery(<InboxSettingsPage />);
    await screen.findByRole("button", { name: "Suggestion agent" });
    await waitFor(() => expect(agentRuntimeRuntime.catalog).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Suggestion agent" }).textContent).toContain(
      "removed:account · Unavailable",
    );
    expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toContain(
      "retired-model · Unavailable",
    );
    await click("Suggestion agent");
    expect(screen.queryByRole("option", { name: "Work OpenCode" })).toBeNull();
    await click("Work Claude", "option");
    expect(updateInboxSettings).toHaveBeenCalledWith({
      suggestionAgent: { instanceId: "claude:work" },
      suggestionModel: null,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toContain(
        "Default · Precise model",
      ),
    );
    await click("Suggestion model");
    await click("Precise model", "option");
    expect(updateInboxSettings).toHaveBeenLastCalledWith({ suggestionModel: "precise-model" });
    await click("New chat runtime");
    expect(screen.getByRole("option", { name: "Work OpenCode" })).toBeTruthy();
  });

  test("shows cold catalog loading without calling the selected Agent or model unavailable", async () => {
    const pending = deferredCatalog();
    vi.mocked(agentRuntimeRuntime.catalog).mockReturnValue(pending.promise);
    vi.mocked(readInboxSettings).mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      suggestionModel: "precise-model",
    });
    renderQuery(<InboxSettingsPage />);
    const agent = await screen.findByRole("button", { name: "Suggestion agent" });
    const model = screen.getByRole("button", { name: "Suggestion model" });
    expect(agent.textContent).toBe("Loading…");
    expect(model.textContent).toBe("Loading…");
    expect((agent as HTMLButtonElement).disabled).toBe(true);
    expect((model as HTMLButtonElement).disabled).toBe(true);
    expect(agentRuntimeRuntime.catalog).toHaveBeenCalledWith();
    await act(async () => pending.resolve([provider("codex", "codex", "Codex")]));
    await waitFor(() => expect(agent.textContent).toBe("Codex"));
    expect(model.textContent).toBe("Precise model");
  });

  test("uses the warm Runtime projection immediately while rechecking it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([provider("codex", "codex", "Codex")]);
    await client.fetchQuery(agentRuntimeProvidersQueryOptions());
    const pending = deferredCatalog();
    vi.mocked(agentRuntimeRuntime.catalog).mockReturnValue(pending.promise);
    renderQuery(<InboxSettingsPage />, client);
    const agent = await screen.findByRole("button", { name: "Suggestion agent" });
    expect(agent.textContent).toBe("Codex");
    expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toBe(
      "Default · Precise model",
    );
    await waitFor(() => expect(agentRuntimeRuntime.catalog).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve([provider("codex", "codex", "Codex")]));
    await settleAsyncRender();
  });

  test("retains a usable catalog through an Agent settings refresh and accepts the new names", async () => {
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([provider("codex", "codex", "Codex")]);
    renderQuery(<InboxSettingsPage />);
    const agent = await screen.findByRole("button", { name: "Suggestion agent" });
    await waitFor(() => expect(agent.textContent).toBe("Codex"));
    const pending = deferredCatalog();
    vi.mocked(agentRuntimeRuntime.catalog).mockReturnValue(pending.promise);
    await act(async () => {
      for (const listener of agentSettingsListeners) listener();
      await Promise.resolve();
    });
    await waitFor(() => expect(agentRuntimeRuntime.catalog).toHaveBeenCalledTimes(2));
    expect(agent.textContent).toBe("Codex");
    expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toBe(
      "Default · Precise model",
    );
    const next = provider("codex", "codex", "Work Codex");
    await act(async () =>
      pending.resolve([{ ...next, models: [{ ...next.models[0]!, name: "Updated model" }] }]),
    );
    await waitFor(() => expect(agent.textContent).toBe("Work Codex"));
    expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toBe(
      "Default · Updated model",
    );
  });

  test("reports a disabled Agent only after the catalog resolves and recovers on its settings event", async () => {
    const current = provider("codex", "codex", "Codex");
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([{ ...current, enabled: false }]);
    renderQuery(<InboxSettingsPage />);
    const agent = await screen.findByRole("button", { name: "Suggestion agent" });
    await waitFor(() => expect(agent.textContent).toBe("Codex · Unavailable"));
    expect(
      (screen.getByRole("button", { name: "Suggestion model" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([current]);
    await act(async () => {
      for (const listener of agentSettingsListeners) listener();
      await Promise.resolve();
    });
    await waitFor(() => expect(agent.textContent).toBe("Codex"));
    expect(
      (screen.getByRole("button", { name: "Suggestion model" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("keeps configured identities distinct from a failed catalog read", async () => {
    vi.mocked(agentRuntimeRuntime.catalog).mockRejectedValue(new Error("offline"));
    vi.mocked(readInboxSettings).mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      suggestionModel: "precise-model",
    });
    renderQuery(<InboxSettingsPage />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("button", { name: "Suggestion agent" }).textContent).toBe("codex");
    expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toBe(
      "precise-model",
    );
    expect(updateInboxSettings).not.toHaveBeenCalled();
  });

  test("keeps the last usable Agent and model when a background catalog refresh fails", async () => {
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([provider("codex", "codex", "Codex")]);
    renderQuery(<InboxSettingsPage />);
    const agent = await screen.findByRole("button", { name: "Suggestion agent" });
    await waitFor(() => expect(agent.textContent).toBe("Codex"));
    vi.mocked(agentRuntimeRuntime.catalog).mockRejectedValue(new Error("offline"));
    await act(async () => {
      for (const listener of agentSettingsListeners) listener();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Retry" });
    expect(agent.textContent).toBe("Codex");
    expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toBe(
      "Default · Precise model",
    );
  });

  test("does not expose editable default settings when the settings read failed", async () => {
    vi.mocked(readInboxSettings).mockRejectedValue(new Error("offline"));
    renderQuery(<InboxSettingsPage />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: "Suggestion agent" })).toBeNull();
    expect(updateInboxSettings).not.toHaveBeenCalled();
  });
});
