import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pluginInterface,
  pluginRow,
  pluginSummary,
} from "../../../../shared/test-fixtures/plugins";
import {
  useInstalledPlugins,
  useMarketplaces,
  useMcpAppDataCapabilities,
  useMcpOauthCompletion,
  usePluginApps,
  usePluginCreationCapabilities,
  usePluginManagement,
  usePluginMcpServers,
  useSkillsPageData,
} from "../plugin-management";
import { PluginsSettingsPage, type PluginsSettingsNavigation } from "./plugins-settings-page";

vi.mock("../plugin-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-management")>()),
  useInstalledPlugins: vi.fn(),
  useMarketplaces: vi.fn(),
  useMcpAppDataCapabilities: vi.fn(),
  useMcpOauthCompletion: vi.fn(),
  usePluginApps: vi.fn(),
  usePluginCreationCapabilities: vi.fn(),
  usePluginManagement: vi.fn(),
  usePluginMcpServers: vi.fn(),
  useSkillsPageData: vi.fn(),
  useSkillContents: vi.fn(() => ({ isPending: true })),
}));

const setPluginEnabled = vi.fn();
const saveMcpServer = vi.fn();
const figma = pluginRow({
  summary: pluginSummary({
    id: "figma@codex-official",
    name: "figma",
    enabled: false,
    interface: pluginInterface({ displayName: "Figma", shortDescription: "Design to code" }),
  }),
  nativeId: "figma@codex-official",
  stableIdentity: "figma@codex-official",
  selector: { marketplacePath: "/marketplace.json", pluginName: "figma" },
});

function renderPage() {
  const navigation: PluginsSettingsNavigation = {
    projectId: null,
    onOpenPluginSettings: vi.fn(),
    onOpenCustomize: vi.fn(),
    onStartChat: vi.fn(),
  };
  render(<PluginsSettingsPage navigation={navigation} />);
  return navigation;
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.mocked(useInstalledPlugins).mockReturnValue({
    data: [figma],
    isPending: false,
    error: null,
  } as never);
  vi.mocked(useSkillsPageData).mockReturnValue({
    settingsSkills: [],
    skillsQuery: { isPending: false },
    recommendedQuery: { isPending: false },
  } as never);
  vi.mocked(usePluginMcpServers).mockReturnValue({
    data: {
      servers: [
        {
          name: "docs",
          declaration: { command: "docs-mcp", enabled: true },
          status: null,
          enabled: true,
          readOnly: false,
          pluginId: null,
        },
      ],
    },
    isPending: false,
  } as never);
  vi.mocked(useMarketplaces).mockReturnValue({
    data: { marketplaces: [], loadErrors: [] },
    isPending: false,
  } as never);
  vi.mocked(useMcpOauthCompletion).mockReturnValue({ data: null } as never);
  vi.mocked(useMcpAppDataCapabilities).mockReturnValue({ data: { available: false } } as never);
  vi.mocked(usePluginApps).mockReturnValue({
    data: {
      apps: [],
      missingAppIds: [],
      connectionError: null,
      connect: { supported: false, reason: null },
    },
    isPending: false,
  } as never);
  vi.mocked(usePluginCreationCapabilities).mockReturnValue({ data: undefined } as never);
  vi.mocked(usePluginManagement).mockReturnValue({
    setPluginEnabled,
    saveMcpServer,
  } as unknown as ReturnType<typeof usePluginManagement>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("counts installed plugins and MCP servers and hides other empty tabs", () => {
  renderPage();

  const tabs = screen.getByRole("group", { name: "Manage extensions" });
  expect(tabs.textContent).toBe("Plugins1MCPs1");
  expect(screen.getByRole("button", { name: /Plugins/, pressed: true })).toBeTruthy();
});

it("switches a plugin on without opening it", async () => {
  setPluginEnabled.mockResolvedValue({ status: "success", value: {}, refreshFailures: [] });
  const navigation = renderPage();

  await click(screen.getByRole("switch", { name: "Toggle plugin enabled state" }));

  expect(setPluginEnabled).toHaveBeenCalledWith({
    pluginId: "figma@codex-official",
    enabled: true,
  });
  expect(navigation.onOpenCustomize).not.toHaveBeenCalled();
});

it("opens the plugin's settings from its row", async () => {
  const navigation = renderPage();

  await click(screen.getByText("Design to code"));

  expect(navigation.onOpenPluginSettings).toHaveBeenCalledWith({
    pluginId: "figma@codex-official",
    pluginName: "figma",
    marketplace: { kind: "local", marketplacePath: "/marketplace.json" },
  });
});

it("edits an MCP server in place and saves its changed command", async () => {
  saveMcpServer.mockResolvedValue({ status: "success", value: undefined, refreshFailures: [] });
  renderPage();

  await click(screen.getByRole("button", { name: /MCPs/ }));
  await click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("heading", { name: "Update Docs MCP" })).toBeTruthy();

  const command = screen.getByDisplayValue("docs-mcp");
  await act(async () => {
    fireEvent.change(command, { target: { value: "docs-mcp --stdio" } });
    await Promise.resolve();
  });
  await click(screen.getByRole("button", { name: "Save" }));

  expect(saveMcpServer).toHaveBeenCalledWith({
    name: "docs",
    previousName: "docs",
    declaration: { command: "docs-mcp --stdio", enabled: true },
  });
  expect(await screen.findByText("docs")).toBeTruthy();
});
