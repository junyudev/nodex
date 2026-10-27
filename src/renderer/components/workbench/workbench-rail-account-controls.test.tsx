import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { CodexAccountSnapshot } from "@/lib/types";
import type { ClaudeUsage } from "@/lib/use-claude-usage";
import { nodexAccountQueryKey } from "@/lib/nodex-account-runtime";
import { installWindowApi } from "@/test/browser-globals";
import { textContent } from "@/test/dom";
import type { ClaudeUsageSnapshot } from "../../../shared/agent-runtime-api";
import type { NodexAccountSnapshot } from "../../../shared/nodex-account";
import { WorkbenchRailAccountControls } from "./workbench-rail-account-controls";

function renderRail(ui: ReactElement) {
  const snapshot: NodexAccountSnapshot = {
    revision: 0,
    configured: false,
    status: "signed-out",
    account: null,
    connection: "unavailable",
    persistence: null,
    error: null,
  };
  installWindowApi({
    invoke: async () => snapshot,
    on: () => () => undefined,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  client.setQueryData(nodexAccountQueryKey, snapshot);
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

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

type ClaudeProvider = NonNullable<ClaudeUsageSnapshot["providers"]>[number];

function claudeProvider(overrides: { readonly readAt?: number | null } = {}): ClaudeProvider {
  const readAt = overrides.readAt === undefined ? Date.now() - 2 * HOUR : overrides.readAt;
  return {
    instanceId: "claude-default",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.310",
    status: "ready",
    auth: { status: "authenticated", email: "dev@example.com", label: "Claude Max" },
    checkedAt: new Date().toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    ...(readAt === null
      ? {}
      : {
          usageLimits: {
            checkedAt: new Date(readAt).toISOString(),
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: 88,
                windowDurationMins: 300,
                resetsAt: new Date(Date.now() + 2 * HOUR).toISOString(),
              },
              {
                id: "seven_day",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 30,
                windowDurationMins: 7 * 24 * 60,
                resetsAt: new Date(Date.now() + 72 * HOUR).toISOString(),
              },
            ],
          },
        }),
  } as unknown as ClaudeProvider;
}

function claudeUsage(
  snapshot: ClaudeUsageSnapshot,
  overrides: Partial<Omit<ClaudeUsage, "snapshot">> = {},
): ClaudeUsage {
  return {
    snapshot,
    refresh: async () => snapshot,
    logout: async () => snapshot,
    ...overrides,
  };
}

const readClaude = (providers: ClaudeUsageSnapshot["providers"]): ClaudeUsageSnapshot => ({
  status: "ready",
  providers,
  reason: null,
});

async function openCard(view: ReturnType<typeof renderRail>, meter: HTMLElement) {
  await act(async () => {
    fireEvent.focus(meter);
    await Promise.resolve();
  });
  return waitFor(() => {
    const found = view.container.ownerDocument.querySelector('[data-usage-card="claude"]');
    if (!found) throw new Error("Expected the Claude usage card");
    return found;
  });
}

describe("WorkbenchRailAccountControls", () => {
  test("draws the Codex account as one ring for the window that runs out first", async () => {
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
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
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
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
    await act(async () => {
      fireEvent.focus(ring);
      await Promise.resolve();
    });

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

    await act(async () => {
      fireEvent.focus(ring);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(refreshCount).toBe(1);
    });
  });

  test("keeps quota resets collapsed and reuses the attempt key after a transport failure", async () => {
    const attempts: Array<{ idempotencyKey: string; creditId?: string | null }> = [];
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
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

    await act(async () => {
      fireEvent.focus(codexMeter(view.container));
      await Promise.resolve();
    });
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
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
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
    expect(Boolean(view.getByRole("button", { name: "Account and settings" }))).toBe(true);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Sign in to Codex" }));
      await Promise.resolve();
    });

    const chatGptLogin = await view.findByRole("button", { name: "Sign in with ChatGPT" });
    // The popover names what it signs in to, so it is never taken for the Nodex Account.
    expect(await view.findByText("Sign in to Codex")).toBeTruthy();
    await act(async () => {
      fireEvent.click(chatGptLogin);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(chatGptLoginCount).toBe(1);
    });
  });

  test("reads Nodex, Codex, then Claude from the bottom up while accounts arrive", () => {
    const renderControls = (
      account: typeof signedOutAccount | null,
      claude: ClaudeUsageSnapshot = { status: "loading", providers: null, reason: null },
    ) => (
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
          account={account}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => signedOutAccount}
          onStartChatGptLogin={async () => ({ type: "apiKey" })}
          onStartApiKeyLogin={async () => ({ type: "apiKey" })}
          onCancelLogin={async () => ({ status: "canceled" })}
          onLogout={async () => undefined}
          claudeUsage={claudeUsage(claude)}
        />
      </NodexTooltipProvider>
    );
    const view = renderRail(renderControls(null));
    const labels = () =>
      view.getAllByRole("button").map((button) => button.getAttribute("aria-label"));

    expect(view.container.querySelector("[data-usage-meter]")).toBe(null);
    expect(labels()).toEqual([
      "Loading Claude usage",
      "Loading Codex account",
      "Account and settings",
    ]);

    // Codex and the Nodex menu always hold the lowest slots, so Claude coming and going never moves them.
    view.rerender(renderControls(signedOutAccount, readClaude([])));
    expect(labels()).toEqual(["Sign in to Codex", "Account and settings"]);
    view.rerender(renderControls(signedOutAccount, readClaude([claudeProvider()])));
    expect(labels()).toEqual([
      "Claude usage: 12% left in 5-hour window, read 2 h ago",
      "Sign in to Codex",
      "Account and settings",
    ]);
  });

  test("says why an unknown account cannot load and asks again when clicked", async () => {
    let refreshCount = 0;
    const unreachable: CodexAccountSnapshot = { ...signedOutAccount, status: "unavailable" };
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
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
  test("adds a Claude meter that says how old its reading is and reads again when opened", async () => {
    let codexRefreshes = 0;
    let claudeRefreshes = 0;
    const signedOut: (readonly string[])[] = [];
    const snapshot = readClaude([claudeProvider()]);
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
          account={authenticatedAccount}
          connection={{ status: "connected", retries: 0 }}
          onRefreshAccount={async () => {
            codexRefreshes += 1;
            return authenticatedAccount;
          }}
          onLogout={async () => undefined}
          claudeUsage={claudeUsage(snapshot, {
            refresh: async () => {
              claudeRefreshes += 1;
              return snapshot;
            },
            logout: async (instanceIds) => {
              signedOut.push(instanceIds);
              return readClaude([]);
            },
          })}
        />
      </NodexTooltipProvider>,
    );

    expect(view.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Claude usage: 12% left in 5-hour window, read 2 h ago",
      "Codex usage: 61% left in weekly window",
      "Account and settings",
    ]);
    const claude = view.container.querySelector<HTMLElement>('[data-usage-meter="claude"]');
    if (!claude) throw new Error("Expected the Claude usage meter");
    expect(claude.hasAttribute("data-usage-stale")).toBe(true);

    const card = await openCard(view, claude);
    expect(textContent(card).includes("dev@example.com")).toBe(true);
    expect(textContent(card).includes("Account limits · read on this computer 2 h ago")).toBe(true);
    expect(
      [...card.querySelectorAll('[role="meter"]')].map((meter) =>
        meter.getAttribute("aria-valuenow"),
      ),
    ).toEqual(["12", "70"]);
    await waitFor(() => expect(claudeRefreshes).toBe(1));
    expect(codexRefreshes).toBe(0);

    const signOut = [...card.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign out",
    );
    if (!signOut) throw new Error("Expected Sign out in the Claude card");
    await act(async () => {
      fireEvent.click(signOut);
      await Promise.resolve();
    });
    await waitFor(() => expect(signedOut).toEqual([["claude-default"]]));
  });

  test("a Claude reading Main could not refresh keeps its level and says so", async () => {
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
          claudeUsage={claudeUsage({
            status: "unavailable",
            providers: [claudeProvider()],
            reason: "Agent execution could not start",
          })}
        />
      </NodexTooltipProvider>,
    );

    const claude = view.getByRole("button", {
      name: "Claude usage: 12% left in 5-hour window, read 2 h ago",
    });
    const card = await openCard(view, claude);
    expect(textContent(card).includes("Couldn't refresh on this computer")).toBe(true);
  });

  test("an unread Claude account says so instead of showing a level", async () => {
    const view = renderRail(
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
          claudeUsage={claudeUsage(readClaude([claudeProvider({ readAt: null })]))}
        />
      </NodexTooltipProvider>,
    );

    const claude = view.getByRole("button", { name: "Claude usage not read yet" });
    expect(claude.querySelector("[data-usage-ring-arc]")).toBe(null);
    expect(claude.querySelector('[data-usage-ring-track="dotted"]')).not.toBe(null);
    const card = await openCard(view, claude);
    expect(textContent(card).includes("Not read on this computer yet")).toBe(true);
    expect(textContent(card).includes("Claude hasn't reported usage limits yet.")).toBe(true);
    expect(view.queryAllByRole("meter")).toHaveLength(0);
  });

  test("holds the Claude slot while Main first reads it and asks again when that fails", async () => {
    let retries = 0;
    const loading: ClaudeUsageSnapshot = { status: "loading", providers: null, reason: null };
    const failed: ClaudeUsageSnapshot = {
      status: "unavailable",
      providers: null,
      reason: "Agent execution could not start",
    };
    const controls = (snapshot: ClaudeUsageSnapshot) => (
      <NodexTooltipProvider>
        <WorkbenchRailAccountControls
          onOpenSettings={() => undefined}
          onOpenAccountSettings={() => undefined}
          claudeUsage={claudeUsage(snapshot, {
            refresh: async () => {
              retries += 1;
              return snapshot;
            },
          })}
        />
      </NodexTooltipProvider>
    );
    const view = renderRail(controls(loading));
    const placeholder = view.getByRole("button", { name: "Loading Claude usage" });
    expect(placeholder.getAttribute("data-rail-account-state")).toBe("loading");

    view.rerender(controls(failed));
    const unavailable = view.getByRole("button", {
      name: "Can't read Claude usage. Retrying automatically",
    });
    await act(async () => {
      fireEvent.click(unavailable);
      await Promise.resolve();
    });
    await waitFor(() => expect(retries).toBe(1));

    // Once Main has read the Agents, a profile without a subscription shows nothing.
    view.rerender(controls(readClaude([])));
    expect(view.queryByRole("button", { name: /Claude usage/ })).toBe(null);
    expect(view.container.querySelector('[data-usage-meter="claude"]')).toBe(null);
  });
});
