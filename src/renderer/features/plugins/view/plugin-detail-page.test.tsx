import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pluginInterface,
  pluginRow,
  pluginSummary,
} from "../../../../shared/test-fixtures/plugins";
import type { CustomizeNavigation } from "../customize-navigation";
import {
  usePluginDetail,
  usePluginManagement,
  type PluginDetailView,
  type PluginRouteTarget,
} from "../plugin-management";
import { PluginDetailPage } from "./plugin-detail-page";

vi.mock("../plugin-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-management")>()),
  usePluginDetail: vi.fn(),
  usePluginManagement: vi.fn(),
  useSkillContents: vi.fn(() => ({ isPending: true })),
}));

// The titlebar slot belongs to the workbench; render the breadcrumb in place instead.
vi.mock("@/lib/workbench-ui-scopes", () => ({
  AppShellHeaderContentRegistrar: ({ content }: { content: ReactNode }) => <>{content}</>,
}));

vi.mock("@/features/local-conversation/view/shared/markdown/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));

const target: PluginRouteTarget = {
  pluginId: "figma@codex-official",
  pluginName: "figma",
  marketplace: { kind: "local", marketplacePath: "/marketplace.json" },
};
const context = { hostId: "local", projectId: "project-1" } as const;
const browse = { tab: "personal", category: null, search: "fig" } as const;

function detailView(summary: Parameters<typeof pluginSummary>[0]): PluginDetailView {
  const pluginSummaryValue = pluginSummary({
    id: target.pluginId,
    name: "figma",
    interface: pluginInterface({
      displayName: "Figma",
      shortDescription: "Design to code",
      developerName: "Figma, Inc.",
      defaultPrompt: [" Implement this frame "],
    }),
    ...summary,
  });
  const row = pluginRow({
    summary: pluginSummaryValue,
    nativeId: target.pluginId,
    stableIdentity: target.pluginId,
    selector: { marketplacePath: "/marketplace.json", pluginName: "figma" },
    installState: pluginSummaryValue.installed ? "installed" : "not_installed",
    actionState: pluginSummaryValue.installed ? "installed_menu" : "install",
  });
  return {
    detail: {} as PluginDetailView["detail"],
    row,
    summary: pluginSummaryValue,
    description: null,
    skills: [],
    skillsError: null,
    apps: [],
    mcpServers: [],
    mcpServerStates: [],
    mcpServerError: null,
    hooks: [],
    hooksNeedingReviewCount: 0,
    hooksError: null,
    hooksAvailable: true,
    info: {
      capabilities: [],
      developer: "Figma, Inc.",
      category: null,
      version: null,
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompts: ["Implement this frame"],
      brandColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
  };
}

function renderPage(view: PluginDetailView | Error) {
  vi.mocked(usePluginDetail).mockReturnValue(
    (view instanceof Error
      ? { data: undefined, isError: true, error: view }
      : { data: view, isError: false, error: null }) as never,
  );
  const navigation: CustomizeNavigation = {
    path: null,
    projectId: context.projectId,
    onNavigate: vi.fn(),
    onStartChat: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenHooksSettings: vi.fn(),
  };
  render(
    <PluginDetailPage context={context} navigation={navigation} target={target} browse={browse} />,
  );
  return navigation;
}

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

const install = vi.fn();
const setPluginEnabled = vi.fn();

beforeEach(() => {
  vi.mocked(usePluginManagement).mockReturnValue({
    install,
    setPluginEnabled,
  } as unknown as ReturnType<typeof usePluginManagement>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("starts a chat that mentions the plugin when a starter prompt is chosen", async () => {
  const navigation = renderPage(detailView({ installed: true, enabled: true }));

  expect(screen.getByRole("heading", { level: 1, name: /Figma/ })).toBeTruthy();
  expect(screen.getByText("By Figma, Inc. • Design to code")).toBeTruthy();
  await click(screen.getByRole("button", { name: /Implement this frame/ }));

  expect(navigation.onStartChat).toHaveBeenCalledWith(
    "[@Figma](plugin://figma@codex-official) Implement this frame",
  );
});

it("installs a plugin before starting a chat from its prompt", async () => {
  install.mockResolvedValue({
    status: "success",
    value: { authPolicy: "ON_USE", appsNeedingAuth: [] },
    refreshFailures: [],
  });
  const navigation = renderPage(detailView({ installed: false, enabled: false }));

  expect(screen.getByRole("button", { name: "Install plugin" })).toBeTruthy();
  await click(screen.getByRole("button", { name: /Implement this frame/ }));

  await waitFor(() =>
    expect(navigation.onStartChat).toHaveBeenCalledWith(
      "[@Figma](plugin://figma@codex-official) Implement this frame",
    ),
  );
  expect(install).toHaveBeenCalledWith(
    expect.objectContaining({ marketplacePath: "/marketplace.json", pluginName: "figma" }),
  );
});

it("leads back to the directory view the plugin was opened from", async () => {
  const navigation = renderPage(detailView({ installed: true, enabled: true }));
  const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });

  expect(breadcrumb.querySelector("[aria-current=page]")?.textContent).toBe("Figma");
  await click(screen.getByRole("button", { name: "Plugins" }));

  expect(navigation.onNavigate).toHaveBeenCalledWith("/plugins?directoryTab=personal&search=fig");
});

it("explains a plugin that fails to load", () => {
  renderPage(new Error("path does not exist"));

  expect(screen.getByText("Failed to load plugin")).toBeTruthy();
  expect(screen.getByText("path does not exist")).toBeTruthy();
});
