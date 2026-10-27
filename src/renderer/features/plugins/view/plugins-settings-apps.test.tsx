import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginAppRow, PluginAppTool } from "../../../../shared/codex-plugin-settings";
import { usePluginAppTools, usePluginApps, usePluginManagement } from "../plugin-management";
import { AppsTab } from "./plugins-settings-apps";

vi.mock("../plugin-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-management")>()),
  usePluginApps: vi.fn(),
  usePluginAppTools: vi.fn(),
  usePluginManagement: vi.fn(),
}));

vi.mock("@/features/local-conversation/view/shared/markdown/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));

const setAppEnabled = vi.fn();
const context = { hostId: "local", projectId: null } as const;

const appRow = (overrides: Partial<PluginAppRow>): PluginAppRow => ({
  id: "connector_linear",
  name: "Linear",
  metadata: null,
  runtime: null,
  enabled: true,
  callable: true,
  editable: true,
  editRestriction: null,
  accessible: true,
  installUrl: null,
  logoUrl: null,
  logoDarkUrl: null,
  connectionState: "connected",
  connections: [],
  canDisconnect: true,
  ...overrides,
});

const tool = (name: string, isReadOnly: boolean): PluginAppTool => ({
  name,
  title: null,
  description: `${name} description`,
  isEnabled: true,
  disabledReason: null,
  isReadOnly,
  editable: true,
  editRestriction: null,
  destructiveHint: null,
});

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.mocked(usePluginApps).mockReturnValue({
    data: {
      apps: [
        appRow({}),
        appRow({ id: "connector_gmail", name: "Gmail", accessible: false }),
        appRow({
          id: "connector_drive",
          name: "Drive",
          editable: false,
          editRestriction: {
            code: "policy_denied",
            message: "This app is disabled by your administrator.",
            retryable: false,
          },
        }),
      ],
      missingAppIds: [],
      connectionError: null,
      connect: { supported: false, reason: null },
    },
    isPending: false,
    isFetching: false,
    error: null,
  } as never);
  vi.mocked(usePluginAppTools).mockReturnValue({
    data: {
      appId: "connector_linear",
      tools: [tool("search_issues", true), tool("create_issue", false)],
      available: true,
      error: null,
      events: [],
      eventsAvailable: false,
    },
    isPending: false,
    error: null,
  } as never);
  vi.mocked(usePluginManagement).mockReturnValue({
    setAppEnabled,
  } as unknown as ReturnType<typeof usePluginManagement>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists connected apps with switches, locking those controlled elsewhere", async () => {
  setAppEnabled.mockResolvedValue({ status: "success", value: undefined, refreshFailures: [] });
  render(<AppsTab context={context} search="" onStartChat={vi.fn()} />);

  expect(screen.queryByText("Gmail")).toBeNull();
  const switches = screen.getAllByRole("switch", { name: "Enable app" });
  // Drive's locked switch is a focusable stand-in that explains why it can't change.
  expect(switches.map((item) => item.getAttribute("aria-disabled") ?? null)).toContain("true");

  await click(switches[0]!);
  expect(setAppEnabled).toHaveBeenCalledWith({ appId: "connector_linear", enabled: false });
});

it("opens an app's tools and tries it in a new chat", async () => {
  const onStartChat = vi.fn();
  render(<AppsTab context={context} search="" onStartChat={onStartChat} />);

  await click(screen.getByText("Linear"));
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("The Linear app contains 2 tools (1 write, 1 read)"),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: /Write/ })).toBeTruthy();

  await click(within(dialog).getByRole("button", { name: /Try now/ }));
  expect(onStartChat).toHaveBeenCalledWith("[@Linear](app://connector_linear)");
});
