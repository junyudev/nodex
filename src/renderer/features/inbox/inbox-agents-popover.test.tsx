import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import { DEFAULT_INBOX_SETTINGS } from "../../../shared/inbox";
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

    // Suggestions run every model at their own economical effort, so only the model is chosen.
    // Suggestions also choose models and plan delegation, so Codex suggests at High.
    const suggestion = await screen.findByRole("button", { name: "Suggestion model" });
    expect(suggestion.textContent).toBe("GPT-6 Astra · High");
    await click(suggestion);
    expect(screen.queryByRole("button", { name: /^Effort/ })).toBeNull();
    await click(screen.getByRole("option", { name: /Opus 5\.5/ }));
    expect(agents.save).toHaveBeenLastCalledWith({
      suggestionAgent: { instanceId: CLAUDE_INSTANCE_ID },
      suggestionModel: "claude-opus-5-5",
    });

    const chat = screen.getByRole("button", { name: "New chat model" });
    expect(chat.textContent).toBe("GPT-6 Astra · Medium");
    await click(chat);
    const effort = screen.getByRole("slider", { name: "Effort" });
    expect(effort.getAttribute("aria-valuetext")).toBe("Medium");
    await act(async () => {
      fireEvent.keyDown(effort, { key: "ArrowRight" });
      await settleAsyncRender();
    });
    expect(agents.save).toHaveBeenLastCalledWith({
      chatAgent: { instanceId: "codex", model: null, reasoningEffort: "high", serviceTier: null },
    });
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
