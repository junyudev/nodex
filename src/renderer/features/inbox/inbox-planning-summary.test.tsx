import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import { DEFAULT_INBOX_SETTINGS, type InboxSettings } from "../../../shared/inbox";
import { claudeProvider, codexProvider, inboxAgentsFixture } from "./inbox-agents.test-support";
import { InboxPlanningSummary } from "./inbox-planning-summary";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Codex has 71% of its week left, read a few minutes ago. */
const codex = () => ({
  ...codexProvider(),
  usageLimits: {
    checkedAt: new Date(NOW - 5 * 60_000).toISOString(),
    windows: [
      {
        id: "secondary",
        kind: "weekly" as const,
        label: "Weekly",
        usedPercent: 29,
        resetsAt: new Date(NOW + 72 * 3_600_000).toISOString(),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
  },
});

const agentsWith = (settings: Partial<InboxSettings> = {}, overrides = {}) =>
  inboxAgentsFixture({
    providers: [codex(), claudeProvider()],
    settings: { ...DEFAULT_INBOX_SETTINGS, ...settings },
    ...overrides,
  });

const act_ = async (run: () => void) => {
  await act(async () => {
    run();
    await settleAsyncRender();
  });
};

describe("how an empty Inbox says it plans", () => {
  test("names who suggests, what chats can run on and the user's own preferences", async () => {
    const agents = agentsWith({ instructions: "Docs go to new read-only chats." });
    render(
      <InboxPlanningSummary
        agents={agents}
        policy={{ kind: "automatic" }}
        nowMs={NOW}
        projectName={null}
      />,
    );
    const planning = await screen.findByRole("region", { name: "How the Inbox plans" });
    // Suggestions run Codex at its fixed, economical effort.
    within(planning).getByRole("button", { name: "Suggests with Codex · GPT-6 Astra · High" });
    // Each Agent the planner may choose, with the rail's ring for what its budget is.
    within(planning).getByRole("button", {
      name: "Codex usage: 71% left in weekly window",
    });
    within(planning).getByRole("button", { name: "Edit routing preferences" });
    // Budgets move while the Inbox sits empty, so it reads Main's catalog again as it appears.
    expect(agents.reload).toHaveBeenCalledOnce();
  });

  test("writes routing preferences in place, and keeps them when writing is abandoned", async () => {
    const agents = agentsWith({ instructions: "Docs go to new read-only chats." });
    render(
      <InboxPlanningSummary
        agents={agents}
        policy={{ kind: "automatic" }}
        nowMs={NOW}
        projectName={null}
      />,
    );
    await act_(() =>
      fireEvent.click(screen.getByRole("button", { name: "Edit routing preferences" })),
    );
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Routing preferences",
    });
    expect(editor.value).toBe("Docs go to new read-only chats.");
    await act_(() => fireEvent.change(editor, { target: { value: "Anything" } }));
    await act_(() => fireEvent.keyDown(editor, { key: "Escape" }));
    expect(agents.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Routing preferences" })).toBeNull();

    await act_(() =>
      fireEvent.click(screen.getByRole("button", { name: "Edit routing preferences" })),
    );
    const again = screen.getByRole("textbox", { name: "Routing preferences" });
    await act_(() =>
      fireEvent.change(again, { target: { value: "  UI work goes to Claude Opus 5.5.\n" } }),
    );
    await act_(() => fireEvent.keyDown(again, { key: "Enter", metaKey: true }));
    expect(agents.save).toHaveBeenCalledWith({ instructions: "UI work goes to Claude Opus 5.5." });
    expect(screen.queryByRole("textbox", { name: "Routing preferences" })).toBeNull();
  });

  test("keeps what was written when it could not be saved", async () => {
    const agents = agentsWith({}, { save: vi.fn(async () => false) });
    render(
      <InboxPlanningSummary
        agents={agents}
        policy={{ kind: "on_request" }}
        nowMs={NOW}
        projectName={null}
      />,
    );
    await act_(() =>
      fireEvent.click(screen.getByRole("button", { name: "Add routing preferences" })),
    );
    const editor = screen.getByRole("textbox", { name: "Routing preferences" });
    await act_(() => fireEvent.change(editor, { target: { value: "Keep notes." } }));
    await act_(() => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(agents.save).toHaveBeenCalledOnce();
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Routing preferences" }).value,
    ).toBe("Keep notes.");
  });

  test("keeps writing that goes on while a save is under way", async () => {
    let finish = (_saved: boolean) => {};
    const save = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    render(
      <InboxPlanningSummary
        agents={agentsWith({}, { save })}
        policy={{ kind: "automatic" }}
        nowMs={NOW}
        projectName={null}
      />,
    );
    await act_(() =>
      fireEvent.click(screen.getByRole("button", { name: "Add routing preferences" })),
    );
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Routing preferences",
    });
    await act_(() => fireEvent.change(editor, { target: { value: "Keep notes." } }));
    await act_(() => fireEvent.keyDown(editor, { key: "Enter", metaKey: true }));
    await act_(() => fireEvent.change(editor, { target: { value: "Keep notes. File bugs." } }));
    await act_(() => finish(true));
    expect(save).toHaveBeenCalledWith({ instructions: "Keep notes." });
    expect(editor.value).toBe("Keep notes. File bugs.");
  });

  test("with suggestions off, shows only what new chats run on", async () => {
    render(
      <InboxPlanningSummary
        agents={agentsWith({ suggestions: "off" })}
        policy={{ kind: "off" }}
        nowMs={NOW}
        projectName={null}
      />,
    );
    const planning = await screen.findByRole("region", { name: "How the Inbox plans" });
    within(planning).getByRole("button", { name: "New chats run on Codex · GPT-6 Astra · Medium" });
    expect(within(planning).queryByRole("button", { name: /routing preferences/i })).toBeNull();
    expect(within(planning).queryByRole("button", { name: /^Suggests with/ })).toBeNull();
  });

  test("shows nothing until the user's settings have arrived", () => {
    render(
      <InboxPlanningSummary
        agents={agentsWith({}, { settingsReady: false })}
        policy={{ kind: "automatic" }}
        nowMs={NOW}
        projectName={null}
      />,
    );
    expect(screen.queryByRole("region", { name: "How the Inbox plans" })).toBeNull();
  });
});
