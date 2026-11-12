import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  InstalledAgentPlugin,
  PluginPackageReview,
  PluginPreview,
} from "../../../../shared/agent-plugins/ipc";
import { installWindowApi } from "../../../test/browser-globals";
import { AgentPluginInstallations } from "./agent-plugin-installations";

const folder = "/packages/notes";
const id = "b".repeat(64);
const pkg: PluginPackageReview = {
  identity: { name: "notes", version: "1.0.0", author: { name: "Nodex" } },
  layout: "portable-1.0.0",
  digest: "a".repeat(64),
  skills: [
    {
      name: "Organize",
      description: "Organize notes",
      directory: "skills/organize",
      valid: true,
      diagnostics: [],
    },
  ],
  mcpServers: [
    {
      key: "local",
      transport: { type: "stdio", command: "node", args: ["server.js"], cwd: "./" },
      configuration: ["CATALOG_TOKEN"],
    },
    {
      key: "catalog",
      transport: { type: "streamable-http", url: "https://example.test/catalog" },
      configuration: [],
    },
  ],
  hooks: [
    {
      source: { kind: "file", path: "hooks.json" },
      events: [{ name: "SessionStart", commands: ["echo ready"] }],
    },
  ],
  apps: [{ kind: "openai-hosted", key: "notes", id: "app_notes" }],
  diagnostics: [{ code: "invalid-server", path: "mcp.json", message: "Unsupported transport" }],
};
const success = <T,>(value: T) => ({ ok: true, value });
const receipt = success({ cleanupWarnings: [] });

function setup(options: { installed?: boolean; preview?: PluginPreview; stale?: boolean } = {}) {
  let installed = options.installed ?? false;
  let stale = options.stale ?? false;
  const active = new Set(["alpha"]);
  const invoke = vi.fn(
    async (channel: string, input?: { projectId?: string; enabled?: boolean }) => {
      switch (channel) {
        case "agent-plugins:list": {
          const entry: InstalledAgentPlugin = {
            id,
            source: { kind: "local", locator: folder },
            package: pkg,
            projectEnabled: input?.projectId != null && active.has(input.projectId),
            effective: null,
          };
          return success({
            installations: installed ? [entry] : [],
            writerStatus: stale ? "stale" : "clear",
          });
        }
        case "agent-plugins:pick-folder":
          return success(folder);
        case "agent-plugins:preview":
          return success(options.preview ?? { status: "loaded", package: pkg });
        case "agent-plugins:install":
          installed = true;
          return receipt;
        case "agent-plugins:uninstall":
          installed = false;
          return receipt;
        case "agent-plugins:set-project-enabled":
          if (!input?.projectId) throw new Error("Expected a Project");
          if (input.enabled) active.add(input.projectId);
          else active.delete(input.projectId);
          return success(undefined);
        case "agent-plugins:repair-writer":
          stale = false;
          return success(undefined);
        default:
          throw new Error(`Unexpected channel: ${channel}`);
      }
    },
  );
  installWindowApi({ invoke, on: () => () => {} });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <AgentPluginInstallations
        defaultProjectId="alpha"
        projects={[
          { id: "alpha", name: "Alpha" },
          { id: "beta", name: "Beta" },
        ]}
      />
    </QueryClientProvider>,
  );
  return invoke;
}

const click = (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
  });
afterEach(cleanup);

it("reviews declarations before sending the reviewed digest for installation", async () => {
  const invoke = setup();
  expect(screen.getByText(/Agent delivery is not yet available/)).toBeTruthy();
  await screen.findByText("No Nodex plugins installed");
  await click(screen.getByRole("button", { name: "Install from folder" }));

  const review = within(await screen.findByRole("region", { name: "Package review" }));
  expect(review.getByText("notes · 1.0.0 · Nodex · Agent Plugins 1.0.0")).toBeTruthy();
  expect(review.getByText("Organize notes", { exact: false })).toBeTruthy();
  expect(review.getByText('"node" "server.js"')).toBeTruthy();
  expect(review.getByText("https://example.test/catalog")).toBeTruthy();
  expect(review.getByRole("heading", { name: /Hooks · Not executed/ })).toBeTruthy();
  expect(review.getByRole("heading", { name: /Require OpenAI-hosted services/ })).toBeTruthy();
  expect(review.getByText("Unsupported transport")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("agent-plugins:preview", { directory: folder });
  expect(invoke.mock.calls.some(([channel]) => channel === "agent-plugins:install")).toBe(false);

  await click(review.getByRole("button", { name: "Confirm install" }));
  expect(invoke).toHaveBeenCalledWith("agent-plugins:install", {
    directory: folder,
    previewDigest: pkg.digest,
  });
  await screen.findByRole("heading", { name: "notes" });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Package review" })).toBeNull());
});

it("shows rejection reasons and prevents confirmation for an unreadable package", async () => {
  setup({
    preview: {
      status: "rejected",
      reasons: [{ code: "missing-manifest", message: "No plugin manifest found." }],
    },
  });
  await screen.findByText("No Nodex plugins installed");
  await click(screen.getByRole("button", { name: "Install from folder" }));
  expect(await screen.findByText("No plugin manifest found.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm install" })).toBeNull();
});

it("shows independent activation for each selected Project", async () => {
  const invoke = setup({ installed: true });
  const activation = (checked: boolean) =>
    screen.findByRole("switch", { name: "Enable notes for this Project", checked });
  await activation(true);
  const select = screen.getByRole("combobox", { name: "Enable for Project" });
  await act(async () => {
    fireEvent.change(select, { target: { value: "beta" } });
  });
  await click(await activation(false));
  await activation(true);
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
  expect(invoke).toHaveBeenCalledWith("agent-plugins:set-project-enabled", {
    id,
    projectId: "beta",
    enabled: true,
  });

  await act(async () => {
    fireEvent.change(select, { target: { value: "alpha" } });
  });
  await click(await activation(true));
  await activation(false);
  await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.change(select, { target: { value: "beta" } });
  });
  await activation(true);
});

it.each(["keep", "delete"] as const)(
  "requires an explicit choice to %s plugin data on uninstall",
  async (data) => {
    const invoke = setup({ installed: true });
    await click(await screen.findByRole("button", { name: "Uninstall notes" }));
    const choice = within(screen.getByRole("group", { name: "Uninstall notes" }));
    expect(invoke.mock.calls.some(([channel]) => channel === "agent-plugins:uninstall")).toBe(
      false,
    );
    await click(choice.getByRole("button", { name: `Uninstall and ${data} plugin data` }));
    expect(invoke).toHaveBeenCalledWith("agent-plugins:uninstall", { id, data });
    await screen.findByText("No Nodex plugins installed");
  },
);

it("clears the stale lock status after repair", async () => {
  const invoke = setup({ stale: true });
  await click(await screen.findByRole("button", { name: "Repair lock" }));
  expect(invoke).toHaveBeenCalledWith("agent-plugins:repair-writer");
  await waitFor(() =>
    expect(screen.queryByText("The plugin registry has a stale lock.")).toBeNull(),
  );
});
