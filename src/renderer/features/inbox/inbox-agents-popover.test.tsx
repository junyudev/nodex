import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import { DEFAULT_INBOX_AGENT_CHOICE, DEFAULT_INBOX_SETTINGS } from "../../../shared/inbox";
import { InboxAgentsPopover } from "./inbox-agents-popover";
import { CLAUDE_INSTANCE_ID, inboxAgentsFixture } from "./inbox-agents.test-support";

const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await settleAsyncRender();
  });
};

describe("the Inbox's settings panel", () => {
  test("changes what suggests and what new chats run on without leaving the Inbox", async () => {
    const agents = inboxAgentsFixture();
    const onOpenSettings = vi.fn();
    render(<InboxAgentsPopover agents={agents} onOpenSettings={onOpenSettings} />);
    await click(screen.getByRole("button", { name: "Inbox settings" }));

    // Suggestions look things up and choose models, so Codex suggests at High until told otherwise.
    // Until chosen, Nodex picks both, and says so.
    const suggestion = await screen.findByRole("button", { name: "Suggestion model" });
    expect(suggestion.textContent).toBe("GPT-6 Astra · HighDefault");
    await click(suggestion);
    const suggestionEffort = screen.getByRole("slider", { name: "Effort" });
    expect(suggestionEffort.getAttribute("aria-valuetext")).toBe("High");
    await act(async () => {
      fireEvent.keyDown(suggestionEffort, { key: "ArrowLeft" });
      await settleAsyncRender();
    });
    // An effort set on the default keeps the model it ran on.
    expect(agents.save).toHaveBeenLastCalledWith({
      suggestionAgent: {
        instanceId: "codex",
        model: "gpt-6-astra",
        reasoningEffort: "medium",
        serviceTier: null,
      },
    });
    await click(screen.getByRole("option", { name: /Opus 5\.5/ }));
    expect(agents.save).toHaveBeenLastCalledWith({
      suggestionAgent: {
        instanceId: CLAUDE_INSTANCE_ID,
        model: "claude-opus-5-5",
        reasoningEffort: null,
        serviceTier: null,
      },
    });

    const chat = screen.getByRole("button", { name: "New chat model" });
    expect(chat.textContent).toBe("GPT-6 Astra · MediumDefault");
    await click(chat);
    const effort = screen.getByRole("slider", { name: "Effort" });
    expect(effort.getAttribute("aria-valuetext")).toBe("Medium");
    await act(async () => {
      fireEvent.keyDown(effort, { key: "ArrowRight" });
      await settleAsyncRender();
    });
    expect(agents.save).toHaveBeenLastCalledWith({
      chatAgent: {
        instanceId: "codex",
        model: "gpt-6-astra",
        reasoningEffort: "high",
        serviceTier: null,
      },
    });
  });

  test("a chosen model can go back to Nodex's default, which the menu names", async () => {
    const agents = inboxAgentsFixture({
      settings: {
        ...DEFAULT_INBOX_SETTINGS,
        chatAgent: {
          instanceId: CLAUDE_INSTANCE_ID,
          model: "claude-opus-5-5",
          reasoningEffort: null,
          serviceTier: null,
        },
      },
    });
    render(<InboxAgentsPopover agents={agents} onOpenSettings={vi.fn()} />);
    await click(screen.getByRole("button", { name: "Inbox settings" }));
    const chat = await screen.findByRole("button", { name: "New chat model" });
    expect(chat.textContent).toBe("Work · Opus 5.5 · High");
    await click(chat);
    const useDefault = await screen.findByRole("button", { name: /^Use the default/ });
    expect(useDefault.textContent).toBe("Use the defaultGPT-6 Astra · Medium");
    await click(useDefault);
    expect(agents.save).toHaveBeenLastCalledWith({ chatAgent: DEFAULT_INBOX_AGENT_CHOICE });
  });

  test("turning suggestions off leaves their model visible but not choosable", async () => {
    const agents = inboxAgentsFixture({
      settings: { ...DEFAULT_INBOX_SETTINGS, suggestions: "off" },
    });
    render(<InboxAgentsPopover agents={agents} onOpenSettings={vi.fn()} />);
    await click(screen.getByRole("button", { name: "Inbox settings" }));
    const suggestion = await screen.findByRole("button", { name: "Suggestion model" });
    expect((suggestion as HTMLButtonElement).disabled).toBe(true);
    const when = screen.getByRole("button", { name: "When to suggest" });
    expect(when.textContent).toContain("Off");
    await click(when);
    await click(await screen.findByRole("menuitem", { name: /When I ask/ }));
    expect(agents.save).toHaveBeenCalledWith({ suggestions: "on_request" });
  });

  test("lets Nodex start the person's clear requests, but only while it routes", async () => {
    const agents = inboxAgentsFixture();
    render(<InboxAgentsPopover agents={agents} onOpenSettings={vi.fn()} />);
    await click(screen.getByRole("button", { name: "Inbox settings" }));
    await click(await screen.findByRole("switch", { name: "Let Nodex start chats for me" }));
    expect(agents.save).toHaveBeenLastCalledWith({ dispatchMode: "act_on_requests" });
  });

  test("nothing starts on its own while suggestions are off", async () => {
    const agents = inboxAgentsFixture({
      settings: { ...DEFAULT_INBOX_SETTINGS, suggestions: "off" },
    });
    render(<InboxAgentsPopover agents={agents} onOpenSettings={vi.fn()} />);
    await click(screen.getByRole("button", { name: "Inbox settings" }));
    const start = await screen.findByRole("switch", { name: "Let Nodex start chats for me" });
    expect(start.hasAttribute("disabled") || start.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
  });

  test("sets where new chats work and what opens beside them, even while suggestions are off", async () => {
    const agents = inboxAgentsFixture({
      settings: { ...DEFAULT_INBOX_SETTINGS, suggestions: "off" },
    });
    render(<InboxAgentsPopover agents={agents} onOpenSettings={vi.fn()} />);
    await click(screen.getByRole("button", { name: "Inbox settings" }));
    const chooseModels = await screen.findByRole("switch", { name: "Suggestions choose models" });
    expect(
      chooseModels.hasAttribute("disabled") ||
        chooseModels.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await click(screen.getByRole("switch", { name: "Use a worktree" }));
    expect(agents.save).toHaveBeenLastCalledWith({ newChatsUseWorktrees: false });
    await click(screen.getByRole("switch", { name: "Open beside their message" }));
    expect(agents.save).toHaveBeenLastCalledWith({ showPageBesideNewChats: false });
  });

  test("hands routing preferences to Settings and closes", async () => {
    const onOpenSettings = vi.fn();
    render(<InboxAgentsPopover agents={inboxAgentsFixture()} onOpenSettings={onOpenSettings} />);
    await click(screen.getByRole("button", { name: "Inbox settings" }));
    await click(await screen.findByRole("button", { name: "Routing preferences and more" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "New chat model" })).toBeNull(),
    );
  });
});
