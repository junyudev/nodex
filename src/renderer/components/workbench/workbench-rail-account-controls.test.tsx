import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CodexAccountSnapshot } from "@/lib/types";
import type { UsageReading } from "@/lib/usage-meter";
import { render, textContent } from "@/test/dom";
import { WorkbenchRailAccountControls } from "./workbench-rail-account-controls";

const authenticatedAccount: CodexAccountSnapshot = {
  status: "ready",
  account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
  requiresOpenAiAuth: false,
  pendingLogin: null,
  rateLimits: {
    primary: {
      usedPercent: 18,
      windowDurationMins: 300,
    },
    secondary: {
      usedPercent: 39,
      windowDurationMins: 7 * 24 * 60,
    },
  },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      {
        id: "reset-credit-1",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1_784_246_400,
        expiresAt: 1_810_166_400,
        title: "Quota reset",
        description: "Reset an eligible Codex quota window.",
      },
    ],
  },
};

const signedOutAccount: CodexAccountSnapshot = {
  status: "ready",
  account: null,
  requiresOpenAiAuth: true,
  pendingLogin: null,
  rateLimits: null,
};

function codexMeter(container: HTMLElement): HTMLElement {
  const meter = container.querySelector<HTMLElement>('[data-usage-meter="codex"]');
  if (!meter) throw new Error("Expected the Codex usage meter");
  return meter;
}

const HOUR = 60 * 60_000;

function claudeReading(overrides: Partial<UsageReading> = {}): UsageReading {
  return {
    provider: "claude",
    key: "claude:dev@example.com|",
    title: "Claude",
    account: "dev@example.com",
    plan: "Claude Max",
    metered: true,
    windows: [
      {
        id: "five_hour",
        label: "5-hour",
        usedPercent: 88,
        resetsAt: Date.now() + 2 * HOUR,
        durationMins: 300,
        scope: "account",
      },
      {
        id: "seven_day",
        label: "Weekly",
        usedPercent: 30,
        resetsAt: Date.now() + 72 * HOUR,
        durationMins: 7 * 24 * 60,
        scope: "account",
      },
    ],
    observedAt: Date.now() - 2 * HOUR,
    readFailed: false,
    refresh: "afterReply",
    ...overrides,
  };
}

describe("WorkbenchRailAccountControls", () => {
  test("draws the Codex account as one ring for the window that runs out first", async () => {
    const view = render(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          account={authenticatedAccount}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => authenticatedAccount}
          onLogout={async () => undefined}
        />
      </NodexTooltipProvider>,
    );

    const ring = view.getByRole("button", { name: "Codex usage: 61% left in weekly window" });
    expect(ring.querySelectorAll("[data-usage-ring-arc]")).toHaveLength(1);
    expect(textContent(view.container).includes("61%")).toBe(false);
  });

  test("shows existing account details on focus and refreshes once while opening", async () => {
    let refreshCount = 0;
    const view = render(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          account={authenticatedAccount}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => {
            refreshCount += 1;
            return authenticatedAccount;
          }}
          onConsumeRateLimitReset={async () => ({
            outcome: "reset",
            account: authenticatedAccount,
          })}
          onLogout={async () => undefined}
        />
      </NodexTooltipProvider>,
    );

    const ring = view.getByRole("button", { name: "Codex usage: 61% left in weekly window" });
    fireEvent.focus(ring);

    await waitFor(() => {
      const bodyText = textContent(view.container.ownerDocument.body);
      if (!bodyText.includes("dev@example.com") || !bodyText.includes("ChatGPT Plus")) {
        throw new Error(`Expected account tooltip details, saw: ${bodyText}`);
      }
      expect(refreshCount).toBe(1);
    });
    const meters = view.getAllByRole("meter");
    expect(meters.map((meter) => meter.getAttribute("aria-label"))).toEqual([
      "5-hour usage remaining",
      "Weekly usage remaining",
    ]);
    expect(meters.map((meter) => meter.getAttribute("aria-valuenow"))).toEqual(["82", "61"]);

    fireEvent.focus(ring);
    await waitFor(() => {
      expect(refreshCount).toBe(1);
    });
  });

  test("keeps quota resets collapsed and reuses the attempt key after a transport failure", async () => {
    const attempts: Array<{ idempotencyKey: string; creditId?: string | null }> = [];
    const view = render(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          account={authenticatedAccount}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => authenticatedAccount}
          onConsumeRateLimitReset={async (input) => {
            attempts.push(input);
            if (attempts.length === 1) throw new Error("transport unavailable");
            return {
              outcome: "alreadyRedeemed",
              account: {
                ...authenticatedAccount,
                rateLimitResetCredits: {
                  availableCount: 1,
                  credits: [],
                },
              },
            };
          }}
          onLogout={async () => undefined}
        />
      </NodexTooltipProvider>,
    );

    fireEvent.focus(codexMeter(view.container));
    const disclosures = await view.findAllByRole("button", { name: "2 quota resets" });
    const disclosure = disclosures.at(-1);
    if (!disclosure) throw new Error("Expected quota-reset disclosure");
    const rateLimitSections = await view.findAllByRole("region", { name: "Usage remaining" });
    expect(rateLimitSections.at(-1)?.contains(disclosure)).toBe(true);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(Boolean(view.queryByRole("button", { name: "Reset quota" }))).toBe(false);

    await act(async () => {
      fireEvent.click(disclosure);
      await Promise.resolve();
    });
    const resetButton = await view.findByRole("button", { name: "Reset quota" });

    await act(async () => {
      fireEvent.click(resetButton);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        textContent(view.container.ownerDocument.body).includes("Couldn’t reset quota. Try again."),
      ).toBe(true);
    });

    await act(async () => {
      fireEvent.click(resetButton);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        textContent(view.container.ownerDocument.body).includes("Quota reset. 1 remaining."),
      ).toBe(true);
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.idempotencyKey).toBe(attempts[1]?.idempotencyKey);
    expect(attempts[0]?.creditId).toBe("reset-credit-1");
  });

  test("shows sign-in in the quota slot for signed-out accounts", async () => {
    let chatGptLoginCount = 0;
    const view = render(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          account={signedOutAccount}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => signedOutAccount}
          onStartChatGptLogin={async () => {
            chatGptLoginCount += 1;
            return { type: "apiKey" };
          }}
          onStartApiKeyLogin={async () => ({ type: "apiKey" })}
          onCancelLogin={async () => ({ status: "canceled" })}
          onLogout={async () => undefined}
        />
      </NodexTooltipProvider>,
    );

    expect(view.container.querySelector("[data-usage-meter]")).toBe(null);
    expect(Boolean(view.getByRole("button", { name: "Settings" }))).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Sign in" }));

    const chatGptLogin = await view.findByRole("button", { name: "Sign in with ChatGPT" });
    fireEvent.click(chatGptLogin);

    await waitFor(() => {
      expect(chatGptLoginCount).toBe(1);
    });
  });

  test("keeps Settings last while the account slot hydrates above it", () => {
    const renderControls = (account: typeof signedOutAccount | null) => (
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          account={account}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => signedOutAccount}
          onStartChatGptLogin={async () => ({ type: "apiKey" })}
          onStartApiKeyLogin={async () => ({ type: "apiKey" })}
          onCancelLogin={async () => ({ status: "canceled" })}
          onLogout={async () => undefined}
        />
      </NodexTooltipProvider>
    );
    const view = render(renderControls(null));
    const labels = () =>
      view.getAllByRole("button").map((button) => button.getAttribute("aria-label"));

    expect(view.container.querySelector("[data-usage-meter]")).toBe(null);
    expect(labels()).toEqual(["Loading Codex account", "Settings"]);

    view.rerender(renderControls(signedOutAccount));
    expect(labels()).toEqual(["Sign in", "Settings"]);
  });

  test("says why an unknown account cannot load and asks again when clicked", async () => {
    let refreshCount = 0;
    const unreachable: CodexAccountSnapshot = { ...signedOutAccount, status: "unavailable" };
    const view = render(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          account={unreachable}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => {
            refreshCount += 1;
            return unreachable;
          }}
          onLogout={async () => undefined}
        />
      </NodexTooltipProvider>,
    );

    const placeholder = view.getByRole("button", {
      name: "Can't reach your Codex account. Retrying automatically",
    });
    expect(placeholder.getAttribute("data-rail-account-state")).toBe("unavailable");
    await act(async () => {
      fireEvent.click(placeholder);
      await Promise.resolve();
    });
    await waitFor(() => expect(refreshCount).toBe(1));
  });
  test("adds a Claude meter that shows how old its reading is and reads nothing when opened", async () => {
    let refreshCount = 0;
    const view = render(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          account={authenticatedAccount}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => {
            refreshCount += 1;
            return authenticatedAccount;
          }}
          onLogout={async () => undefined}
          claudeUsage={[claudeReading()]}
        />
      </NodexTooltipProvider>,
    );

    expect(view.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Codex usage: 61% left in weekly window",
      "Claude usage: 12% left in 5-hour window, read 2 h ago",
      "Settings",
    ]);
    const claude = view.container.querySelector<HTMLElement>('[data-usage-meter="claude"]');
    if (!claude) throw new Error("Expected the Claude usage meter");
    expect(claude.hasAttribute("data-usage-stale")).toBe(true);

    fireEvent.focus(claude);
    const card = await waitFor(() => {
      const found = view.container.ownerDocument.querySelector('[data-usage-card="claude"]');
      if (!found) throw new Error("Expected the Claude usage card");
      return found;
    });
    expect(textContent(card).includes("dev@example.com")).toBe(true);
    expect(textContent(card).includes("Claude Max")).toBe(false);
    expect(textContent(card).includes("Account limits · read on this computer 2 h ago")).toBe(true);
    expect(textContent(card).includes("Updates when Claude replies in Nodex.")).toBe(true);
    expect(
      [...card.querySelectorAll('[role="meter"]')].map((meter) =>
        meter.getAttribute("aria-valuenow"),
      ),
    ).toEqual(["12", "70"]);
    expect(Boolean(card.querySelector("button"))).toBe(false);
    expect(refreshCount).toBe(0);
  });

  test("an unread Claude account says so instead of showing a level", async () => {
    const view = render(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          claudeUsage={[claudeReading({ windows: [], observedAt: null })]}
        />
      </NodexTooltipProvider>,
    );

    const claude = view.getByRole("button", { name: "Claude usage not read yet" });
    expect(claude.querySelector("[data-usage-ring-arc]")).toBe(null);
    expect(claude.querySelector('[data-usage-ring-track="dotted"]')).not.toBe(null);
    fireEvent.focus(claude);
    await waitFor(() => {
      const bodyText = textContent(view.container.ownerDocument.body);
      if (
        !bodyText.includes("Not read on this computer yet") ||
        !bodyText.includes("Updates when Claude replies in Nodex.")
      ) {
        throw new Error(`Expected the unread explanation, saw: ${bodyText}`);
      }
    });
    expect(view.queryAllByRole("meter")).toHaveLength(0);
  });
});
