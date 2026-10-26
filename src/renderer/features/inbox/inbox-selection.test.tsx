import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import { DEFAULT_INBOX_SETTINGS, type InboxChat } from "../../../shared/inbox";
import { readInboxChatTargets, readInboxSettings, updateInboxSettings } from "@/lib/inbox-runtime";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import { agentRuntimeProvidersQueryOptions } from "@/lib/use-agent-runtime-providers";
import { InboxDispatchEditor, draftFromAction } from "./inbox-dispatch-editor";
import { InboxSettingsPage } from "./inbox-settings-page";
import {
  CLAUDE_INSTANCE,
  CLAUDE_INSTANCE_ID,
  claudeProvider,
  codexProvider,
  inboxAgentsFixture,
} from "./inbox-agents.test-support";

vi.mock("@/lib/inbox-runtime", () => ({
  readInboxChatTargets: vi.fn(),
  readInboxSettings: vi.fn(),
  updateInboxSettings: vi.fn(),
}));

const { agentSettingsListeners } = vi.hoisted(() => ({
  agentSettingsListeners: new Set<() => void>(),
}));
const OPENCODE_INSTANCE = { kind: "opencode", instanceConfigId: "work" } as const;
const OPENCODE_INSTANCE_ID = agentRuntimeProviderId(OPENCODE_INSTANCE)!;
vi.mock("@/lib/agent-runtime-runtime", () => ({ agentRuntimeRuntime: { catalog: vi.fn() } }));
vi.mock("@/features/local-conversation/use-agent-instances", () => ({
  useAgentInstances: () => ({
    instances: [
      { binding: CLAUDE_INSTANCE, label: "Work", enabled: true },
      { binding: OPENCODE_INSTANCE, label: "Work OpenCode", enabled: true },
    ],
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));
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
        agents={inboxAgentsFixture()}
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
        agents={inboxAgentsFixture()}
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
      {
        chat: expect.objectContaining({
          sessionId: "session:old",
          displayTitle: "Research findings",
        }),
        chatAgent: null,
      },
    );
  });

  test("a hand-written new chat shows and changes what it runs on beside Start chat", async () => {
    const onSubmit = vi.fn(async () => true);
    renderQuery(
      <InboxDispatchEditor
        initial={draftFromAction(
          { type: "new_chat", projectId: null, prompt: "Compare both" },
          "Compare both",
        )}
        projects={[]}
        agents={inboxAgentsFixture()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await click("Runs on Codex · GPT-6 Astra · Medium");
    await click("Effort Medium");
    await click("High", "menuitem");
    await click("Start chat");
    expect(onSubmit).toHaveBeenCalledWith(
      { type: "new_chat", projectId: null, prompt: "Compare both" },
      {
        chat: null,
        chatAgent: { instanceId: "codex", model: null, reasoningEffort: "high", serviceTier: null },
      },
    );
  });

  test("keeps an unavailable suggestion choice explicit and offers only Agents that can suggest", async () => {
    vi.mocked(readInboxSettings).mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      suggestionAgent: { instanceId: "removed:account" },
      suggestionModel: "retired-model",
    });
    const opencode = provider(OPENCODE_INSTANCE_ID, "opencode", "OpenCode");
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([
      provider(CLAUDE_INSTANCE_ID, "claudeAgent", "Claude"),
      {
        ...opencode,
        models: [{ ...opencode.models[0]!, slug: "open-model-free", name: "Open model" }],
      },
    ]);
    renderQuery(<InboxSettingsPage />);
    const suggestion = await screen.findByRole("button", { name: "Suggestion model" });
    await waitFor(() => expect(suggestion.textContent).toBe("removed:account · Unavailable"));
    await click("Suggestion model");
    expect(screen.queryByRole("option", { name: /Open model/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Precise model/ }));
      await settleAsyncRender();
    });
    expect(updateInboxSettings).toHaveBeenLastCalledWith({
      suggestionAgent: { instanceId: CLAUDE_INSTANCE_ID },
      suggestionModel: "precise-model",
    });
    await waitFor(() => expect(suggestion.textContent).toBe("Work · Precise model"));
    // Any Agent can run the chats the Inbox starts.
    await click("New chat model");
    expect(screen.getByRole("option", { name: /Open model/ })).toBeTruthy();
  });

  test("chooses the Agent, model and effort of the Inbox's chats from the composer's menu", async () => {
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([codexProvider(), claudeProvider()]);
    renderQuery(<InboxSettingsPage />);
    const trigger = await screen.findByRole("button", { name: "New chat model" });
    await waitFor(() => expect(trigger.textContent).toBe("GPT-6 Astra · Medium"));
    await click("New chat model");
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Opus 5\.5/ }));
      await settleAsyncRender();
    });
    expect(updateInboxSettings).toHaveBeenLastCalledWith({
      chatAgent: {
        instanceId: CLAUDE_INSTANCE_ID,
        model: "claude-opus-5-5",
        reasoningEffort: null,
        serviceTier: null,
      },
    });
    await waitFor(() => expect(trigger.textContent).toBe("Work · Opus 5.5 · High"));
  });

  test("shows cold catalog loading without calling the chosen model unavailable", async () => {
    const pending = deferredCatalog();
    vi.mocked(agentRuntimeRuntime.catalog).mockReturnValue(pending.promise);
    vi.mocked(readInboxSettings).mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      suggestionModel: "precise-model",
    });
    renderQuery(<InboxSettingsPage />);
    const model = await screen.findByRole("button", { name: "Suggestion model" });
    expect(model.textContent).toBe("Codex · Loading…");
    expect((model as HTMLButtonElement).disabled).toBe(true);
    expect(agentRuntimeRuntime.catalog).toHaveBeenCalledWith();
    await act(async () => pending.resolve([provider("codex", "codex", "Codex")]));
    await waitFor(() => expect(model.textContent).toBe("Precise model"));
    expect((model as HTMLButtonElement).disabled).toBe(false);
  });

  test("uses the warm Runtime projection immediately while rechecking it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([provider("codex", "codex", "Codex")]);
    await client.fetchQuery(agentRuntimeProvidersQueryOptions());
    const pending = deferredCatalog();
    vi.mocked(agentRuntimeRuntime.catalog).mockReturnValue(pending.promise);
    renderQuery(<InboxSettingsPage />, client);
    const model = await screen.findByRole("button", { name: "Suggestion model" });
    expect(model.textContent).toBe("Precise model");
    await waitFor(() => expect(agentRuntimeRuntime.catalog).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve([provider("codex", "codex", "Codex")]));
    await settleAsyncRender();
  });

  test("retains a usable catalog through an Agent settings refresh and accepts the new names", async () => {
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([provider("codex", "codex", "Codex")]);
    renderQuery(<InboxSettingsPage />);
    const model = await screen.findByRole("button", { name: "Suggestion model" });
    await waitFor(() => expect(model.textContent).toBe("Precise model"));
    const pending = deferredCatalog();
    vi.mocked(agentRuntimeRuntime.catalog).mockReturnValue(pending.promise);
    await act(async () => {
      for (const listener of agentSettingsListeners) listener();
      await Promise.resolve();
    });
    await waitFor(() => expect(agentRuntimeRuntime.catalog).toHaveBeenCalledTimes(2));
    expect(model.textContent).toBe("Precise model");
    const next = provider("codex", "codex", "Work Codex");
    await act(async () =>
      pending.resolve([{ ...next, models: [{ ...next.models[0]!, name: "Updated model" }] }]),
    );
    await waitFor(() => expect(model.textContent).toBe("Work Codex · Updated model"));
  });

  test("reports a disabled Agent only after the catalog resolves and recovers on its settings event", async () => {
    const current = provider("codex", "codex", "Codex");
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([{ ...current, enabled: false }]);
    renderQuery(<InboxSettingsPage />);
    const model = await screen.findByRole("button", { name: "Suggestion model" });
    await waitFor(() => expect(model.textContent).toBe("Codex · Unavailable"));
    // An unavailable Agent stays choosable away from.
    expect((model as HTMLButtonElement).disabled).toBe(false);
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([current]);
    await act(async () => {
      for (const listener of agentSettingsListeners) listener();
      await Promise.resolve();
    });
    await waitFor(() => expect(model.textContent).toBe("Precise model"));
  });

  test("keeps configured identities distinct from a failed catalog read", async () => {
    vi.mocked(agentRuntimeRuntime.catalog).mockRejectedValue(new Error("offline"));
    vi.mocked(readInboxSettings).mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      suggestionModel: "precise-model",
    });
    renderQuery(<InboxSettingsPage />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("button", { name: "Suggestion model" }).textContent).toBe(
      "Codex · precise-model",
    );
    expect(updateInboxSettings).not.toHaveBeenCalled();
  });

  test("keeps the last usable Agent and model when a background catalog refresh fails", async () => {
    vi.mocked(agentRuntimeRuntime.catalog).mockResolvedValue([provider("codex", "codex", "Codex")]);
    renderQuery(<InboxSettingsPage />);
    const model = await screen.findByRole("button", { name: "Suggestion model" });
    await waitFor(() => expect(model.textContent).toBe("Precise model"));
    vi.mocked(agentRuntimeRuntime.catalog).mockRejectedValue(new Error("offline"));
    await act(async () => {
      for (const listener of agentSettingsListeners) listener();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Retry" });
    expect(model.textContent).toBe("Precise model");
  });

  test("does not expose editable default settings when the settings read failed", async () => {
    vi.mocked(readInboxSettings).mockRejectedValue(new Error("offline"));
    renderQuery(<InboxSettingsPage />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: "Suggestion model" })).toBeNull();
    expect(updateInboxSettings).not.toHaveBeenCalled();
  });
});
