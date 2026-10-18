import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { render, settleAsyncRender } from "@/test/dom";
import { DEFAULT_INBOX_SETTINGS, type InboxChat } from "../../../shared/inbox";
import {
  readInboxAgentCatalog,
  readInboxChatTargets,
  readInboxSettings,
  updateInboxSettings,
} from "@/lib/inbox-runtime";
import { InboxDispatchEditor, draftFromAction } from "./inbox-dispatch-editor";
import { InboxSettingsPage } from "./inbox-settings-page";

vi.mock("@/lib/inbox-runtime", () => ({
  readInboxChatTargets: vi.fn(),
  readInboxAgentCatalog: vi.fn(),
  readInboxSettings: vi.fn(),
  updateInboxSettings: vi.fn(),
}));

const renderQuery = (children: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>,
  );
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
  status: null,
  unread: false,
  archived: false,
});
const provider = (
  instanceId: string,
  driver: Awaited<ReturnType<typeof readInboxAgentCatalog>>[number]["driver"],
  displayName: string,
): Awaited<ReturnType<typeof readInboxAgentCatalog>>[number] => ({
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readInboxSettings).mockResolvedValue(DEFAULT_INBOX_SETTINGS);
  vi.mocked(readInboxAgentCatalog).mockResolvedValue([]);
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
    expect(onSubmit).toHaveBeenCalledWith({
      type: "send_to_chat",
      sessionId: "session:old",
      prompt: "Continue",
    });
  });

  test("keeps an unavailable selected Agent and model explicit, and selects real catalog IDs", async () => {
    vi.mocked(readInboxSettings).mockResolvedValue({
      ...DEFAULT_INBOX_SETTINGS,
      suggestionAgent: { instanceId: "removed:account" },
      suggestionModel: "retired-model",
    });
    vi.mocked(readInboxAgentCatalog).mockResolvedValue([
      provider("claude:work", "claudeAgent", "Work Claude"),
      provider("other:work", "opencode", "Work OpenCode"),
    ]);
    renderQuery(<InboxSettingsPage />);
    await screen.findByRole("button", { name: "Suggestion agent" });
    await waitFor(() => expect(readInboxAgentCatalog).toHaveBeenCalled());
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

  test("does not expose editable default settings when the settings read failed", async () => {
    vi.mocked(readInboxSettings).mockRejectedValue(new Error("offline"));
    renderQuery(<InboxSettingsPage />);
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("button", { name: "Suggestion agent" })).toBeNull();
    expect(updateInboxSettings).not.toHaveBeenCalled();
  });
});
