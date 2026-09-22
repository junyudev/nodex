import { afterEach, describe, expect, test } from "vite-plus/test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { HookStatsIndicator } from "./hook-stats-indicator";
import { CodexThreadSettingsProvider } from "@/lib/use-codex-thread-settings";
import { THREAD_SETTINGS_STORAGE_KEY } from "@/lib/codex-thread-settings";
import type { HookStats } from "../../projection/hook-stats";

const stats: HookStats = {
  count: 3,
  blockedCount: 1,
  blockedMessages: [],
  blockedSources: [],
  errorCount: 1,
  entries: [
    { kind: "warning", text: "Check the configuration" },
    { kind: "feedback", text: "Try again" },
  ],
  runs: [
    {
      id: "session",
      eventName: "sessionStart",
      source: "user",
      statusMessage: null,
      entries: [],
      count: 2,
    },
    {
      id: "submit",
      eventName: "userPromptSubmit",
      source: "mdm",
      statusMessage: "Review required",
      entries: [{ tone: "error", text: "Try again" }],
      count: 1,
    },
  ],
};

afterEach(() => {
  cleanup();
  localStorage.removeItem(THREAD_SETTINGS_STORAGE_KEY);
});

describe("hook statistics tooltip", () => {
  test("opens detailed lifecycle and source rows on keyboard focus and closes on Escape", async () => {
    const view = render(<HookStatsIndicator stats={stats} />);
    expect(view.queryByRole("tooltip")).toBeNull();
    await act(async () => {
      view.getByRole("button", { name: "Hooks" }).focus();
      await Promise.resolve();
    });
    const tooltip = within(await view.findByRole("tooltip"));
    expect(tooltip.getByText("SessionStart")).toBeTruthy();
    expect(tooltip.getByText("User · 2 runs")).toBeTruthy();
    expect(tooltip.getByText("Admin")).toBeTruthy();
    expect(tooltip.getByText("Review required")).toBeTruthy();
    expect(tooltip.getByText("Try again")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByRole("tooltip")).toBeNull());
  });

  test.each(["STEPS_PROSE", "STEPS_EXECUTION"])(
    "uses counts and labelled output for %s",
    async (detailLevel) => {
      localStorage.setItem(THREAD_SETTINGS_STORAGE_KEY, JSON.stringify({ detailLevel }));
      const view = render(
        <CodexThreadSettingsProvider>
          <HookStatsIndicator stats={stats} />
        </CodexThreadSettingsProvider>,
      );
      await act(async () => {
        view.getByRole("button", { name: "Hooks" }).focus();
        await Promise.resolve();
      });
      const tooltip = within(await view.findByRole("tooltip"));
      expect(tooltip.getByText("Hooks summary")).toBeTruthy();
      expect(tooltip.getByText("Ran").nextElementSibling?.textContent).toBe("3");
      expect(tooltip.getByText("Blocked").nextElementSibling?.textContent).toBe("1");
      expect(tooltip.getByText("Errors").nextElementSibling?.textContent).toBe("1");
      expect(tooltip.getByText("Message").nextElementSibling?.textContent).toBe(
        "Check the configuration",
      );
      expect(tooltip.getByText("Feedback").nextElementSibling?.textContent).toBe("Try again");
      expect(tooltip.queryByText("SessionStart")).toBeNull();
    },
  );
});
