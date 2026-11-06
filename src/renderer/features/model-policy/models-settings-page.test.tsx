import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { SettingsSectionPageProps } from "@/components/workbench/workbench-settings-page-registry";
import { DEFAULT_MODEL_POLICY, type ModelPolicy } from "../../../shared/model-policy";
import { ModelsSettingsPage } from "./models-settings-page";

const updateSettings = vi.fn(async (next: ModelPolicy) => next);
let policy: ModelPolicy;
let runningOnCredit: readonly unknown[];
let signedIn: boolean;

const provider = (
  instanceId: string,
  driver: string,
  displayName: string,
  source: string | undefined,
  ...models: readonly (readonly [string, string])[]
) => ({
  instanceId,
  driver,
  displayName,
  ...(source ? { source } : {}),
  models: models.map(([slug, name]) => ({ slug, name })),
});
const PROVIDERS = [
  provider(
    "nodex_codex_a",
    "codex",
    "Nodex",
    "nodex",
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ),
  provider("nodex_claude_a", "claudeAgent", "Nodex", "nodex", [
    "claude-opus-5-5",
    "Claude Opus 5.5",
  ]),
  provider("codex", "codex", "Codex", undefined, ["gpt-5.6-sol", "GPT-5.6 Sol"]),
  provider(
    "opencode_a",
    "opencode",
    "OpenCode",
    undefined,
    ["opencode/beam-free", "Beam Free"],
    ["google/gemini-3.5-flash", "Gemini 3.5 Flash"],
  ),
];

vi.mock("./model-policy", () => ({
  useModelPolicy: () => ({
    settings: policy,
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings,
  }),
  useModelPolicyCatalog: () => ({
    data: { providers: PROVIDERS, runningOnCredit, complete: true },
    error: null,
    isPending: false,
  }),
}));
vi.mock("@/features/nodex-account/use-nodex-account", () => ({
  useNodexAccount: () => ({
    snapshot: {
      configured: true,
      status: signedIn ? "signed-in" : "signed-out",
      connection: "available",
      credit: { balance: 12.5, unit: "USD" },
      creditsPerUsd: 25,
      modelStatus: {
        creditsPerUsd: 25,
        pricing: {
          groups: [
            {
              models: [{ id: "gpt-6-luna", multiplier: 0.5 }],
            },
          ],
        },
      },
    },
  }),
}));
vi.mock("@/features/nodex-account/nodex-account-identity", () => ({
  resolveNodexAccountView: (account: { snapshot: { status: string } }) => ({
    signedIn: account.snapshot.status === "signed-in",
  }),
}));

const onPathChange = vi.fn();
const renderPage = () =>
  render(
    <NodexTooltipProvider>
      <ModelsSettingsPage
        {...({
          open: true,
          onPathChange,
          settingsAnchor: null,
        } as unknown as SettingsSectionPageProps)}
      />
    </NodexTooltipProvider>,
  );
const toggle = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name }));
    await Promise.resolve();
  });
};
const lastPolicy = () => updateSettings.mock.lastCall?.[0];

beforeEach(() => {
  policy = DEFAULT_MODEL_POLICY;
  runningOnCredit = [];
  signedIn = true;
  updateSettings.mockClear();
  onPathChange.mockClear();
});
afterEach(cleanup);

test("opens on Nodex with its credits, its models and Agents kept out by default", () => {
  renderPage();
  expect(screen.getByText("Spends your credits. 312 left.")).toBeDefined();
  expect(
    screen
      .getByRole("switch", { name: "Let Agents choose Nodex models" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(screen.getByText("3 of 3 on")).toBeDefined();
  // The rate reads the same here as in Model prices, beside the model it applies to.
  expect(within(screen.getByText("GPT-6 Luna").closest("label")!).getByText("×0.5")).toBeDefined();
  expect(within(screen.getByText("GPT-6.1 Sol").closest("label")!).queryByText(/×/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Prices and top up" }));
  expect(onPathChange).toHaveBeenCalledOnce();
});

test("offers no Nodex card to someone who isn't signed in", () => {
  signedIn = false;
  renderPage();
  expect(screen.queryByText(/Spends your credits/u)).toBeNull();
  expect(screen.getByText("Codex")).toBeDefined();
});

test("turning a model off keeps its own switch independent of the account", async () => {
  renderPage();
  await toggle("GPT-6.1 Sol");
  expect(lastPolicy()?.exceptions).toEqual(['["nodex","codex","gpt-6.1-sol"]']);
});

test("lets the person allow Agents to choose Nodex models", async () => {
  renderPage();
  await toggle("Let Agents choose Nodex models");
  expect(lastPolicy()?.agentsMayChooseCredit).toBe(true);
});

test("collapses an off provider to one line that says what it guarantees", async () => {
  policy = { ...DEFAULT_MODEL_POLICY, providersOff: ["nodex"] };
  renderPage();
  expect(screen.getByText("Off. Nothing on this computer can spend your credits.")).toBeDefined();
  expect(screen.queryByRole("switch", { name: "GPT-6.1 Sol" })).toBeNull();
  await toggle("Turn on Nodex");
  expect(lastPolicy()?.providersOff).toEqual([]);
});

test("asks before turning off what a running chat is spending on", async () => {
  runningOnCredit = [
    {
      rootThreadId: "root",
      threadId: "root",
      instanceId: "nodex_codex_a",
      model: "gpt-6.1-sol",
      sessionId: "session",
    },
  ];
  renderPage();
  await toggle("Turn off all Nodex models");
  expect(updateSettings).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Stop 1 chat and turn off Nodex?")).toBeDefined();
  expect(within(dialog).getByText(/running on GPT-6\.1 Sol/u)).toBeDefined();
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep on" }));
    await Promise.resolve();
  });
  expect(updateSettings).not.toHaveBeenCalled();
  await toggle("Turn off all Nodex models");
  const confirmation = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(within(confirmation).getByRole("button", { name: "Stop and turn off" }));
    await Promise.resolve();
  });
  expect(lastPolicy()?.providersOff).toEqual(["nodex"]);
});

test("doesn't interrupt anything when a model nothing is running on turns off", async () => {
  runningOnCredit = [
    {
      rootThreadId: "root",
      threadId: "root",
      instanceId: "nodex_codex_a",
      model: "gpt-6-luna",
      sessionId: null,
    },
  ];
  renderPage();
  await toggle("GPT-6.1 Sol");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(updateSettings).toHaveBeenCalledOnce();
});

test("filtering opens the cards it matches and hides the rest", async () => {
  renderPage();
  expect(
    screen.getByText("Gemini 3.5 Flash", { selector: "span" }).closest("[data-closed]"),
  ).not.toBeNull();
  await act(async () => {
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter models" }), {
      target: { value: "gemini" },
    });
    await Promise.resolve();
  });
  expect(screen.getByRole("switch", { name: "Gemini 3.5 Flash" })).toBeDefined();
  expect(screen.queryByText(/Spends your credits/u)).toBeNull();
  expect(screen.queryByRole("switch", { name: "GPT-5.6 Sol" })).toBeNull();
});

test("Free only returns OpenCode to its free models", async () => {
  policy = {
    ...DEFAULT_MODEL_POLICY,
    exceptions: ['"unused"', JSON.stringify(["opencode_a", "google/gemini-3.5-flash"])],
  };
  renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /OpenCode/u }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Free only" }));
    await Promise.resolve();
  });
  expect(lastPolicy()?.exceptions).toEqual(['"unused"']);
});
