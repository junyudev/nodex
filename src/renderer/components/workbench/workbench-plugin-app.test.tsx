import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { WorkbenchAppRail } from "./workbench-app-rail";
import { WorkspaceFilePluginActions } from "@/features/workspace-files/workspace-file-plugin-actions";
import { PluginAppView } from "@/features/plugins/view/plugin-app-view";
import { renderWithQuery } from "../../test/query";
import { derivePluginAppEntrypoints } from "../../../shared/agent-plugins/app-entrypoints";

const { open, list, subscription } = vi.hoisted(() => ({
  open: vi.fn(),
  list: vi.fn(),
  subscription: vi.fn((_listener: (event: { kind: string }) => void) => () => {}),
}));
vi.mock("@/lib/plugin-app-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plugin-app-adapter")>();
  return {
    ...actual,
    pluginAppAdapter: { ...actual.pluginAppAdapter, open, subscribe: subscription },
  };
});
vi.mock("@/lib/renderer-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-transport")>()),
  resolveRendererTransport: () => ({ subscribePluginAppEvents: subscription }),
}));
vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokeRendererQuery: async (_channel: string, projectId: string | null) => ({
    ok: true,
    value: await list(projectId),
  }),
}));

const pluginId = "workbench-field-notes@nodex-local";
const catalog = derivePluginAppEntrypoints("notes", [
  {
    name: "open_notes",
    inputSchema: { type: "object" },
    _meta: {
      ui: { resourceUri: "ui://field-notes/view.html" },
      "openai/ui": {
        entrypoints: [{ type: "global" }, { type: "file", extensions: [".fieldnote"] }],
      },
    },
  },
]).map((entry) => ({ pluginId, entryTitle: entry.title, pluginName: "Field Notes", entry }));

test("only the current Project's enabled global app appears in the rail", async () => {
  list.mockImplementation(async (projectId) => (projectId === "field" ? catalog : []));
  const onOpenPluginApp = vi.fn();
  const noop = () => {};
  const rail = (projectId: string) => (
    <WorkbenchAppRail
      pluginProjectId={projectId}
      destination="home"
      onOpenPluginApp={onOpenPluginApp}
      onHome={noop}
      onSpace={noop}
      onAutomations={noop}
      onInsights={noop}
      onPlugins={noop}
    />
  );
  const view = renderWithQuery(rail("field"));
  const button = await screen.findByRole("button", { name: "Field Notes" });
  await act(async () => {
    fireEvent.click(button);
  });
  expect(onOpenPluginApp).toHaveBeenCalledWith(
    {
      kind: "global",
      pluginId,
      projectId: "field",
      entryId: '["notes","open_notes","global"]',
      presentation: expect.objectContaining({ pluginName: "Field Notes" }),
    },
    "Field Notes",
  );
  await act(async () => {
    view.rerender(rail("other"));
  });
  expect(screen.queryByRole("button", { name: "Field Notes" })).toBeNull();
  expect(list).toHaveBeenCalledWith("other");
  await act(async () => {
    view.rerender(rail("field"));
  });
  await screen.findByRole("button", { name: "Field Notes" });
  list.mockResolvedValue([]);
  const invalidate = subscription.mock.lastCall?.[0];
  if (!invalidate) throw new Error("The rail did not subscribe to installation changes");
  await act(async () => {
    invalidate({ kind: "catalog-changed" });
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Field Notes" })).toBeNull());
});

test("the Files action opens the matching viewer with the original host-qualified target", async () => {
  list.mockResolvedValue(catalog);
  const onOpen = vi.fn();
  const actions = (path: string) => (
    <WorkspaceFilePluginActions projectId="field" hostId="host-1" path={path} onOpen={onOpen} />
  );
  const view = renderWithQuery(actions("/workspace/Day.FIELDNOTE"));
  const button = await screen.findByRole("button", { name: "Open with Field Notes" });
  await act(async () => {
    fireEvent.click(button);
  });
  expect(onOpen).toHaveBeenCalledWith(
    {
      kind: "file",
      pluginId,
      projectId: "field",
      entryId: '["notes","open_notes","file"]',
      file: { hostId: "host-1", path: "/workspace/Day.FIELDNOTE" },
      presentation: expect.objectContaining({ pluginName: "Field Notes" }),
    },
    "Day.FIELDNOTE",
  );
  view.rerender(actions("/workspace/Day.txt"));
  expect(screen.queryByRole("button", { name: "Open with Field Notes" })).toBeNull();
});

test.each(["global", "thread", "file"] as const)(
  "a restored %s app keeps its repair actions when the plugin is unavailable",
  async (kind) => {
    open.mockClear();
    open.mockResolvedValue({
      ok: false,
      error: {
        code: "app_unavailable",
        message: "This plugin app is unavailable for this Project.",
      },
    });
    const entry = {
      projectId: "field",
      pluginId,
      entryId: JSON.stringify(["notes", "open_notes", kind]),
    };
    const binding =
      kind === "thread"
        ? ({ ...entry, kind, sessionId: "chat" } as const)
        : kind === "file"
          ? ({ ...entry, kind, file: { hostId: "local", path: "/work/notes.fieldnote" } } as const)
          : ({ ...entry, kind } as const);
    const onOpenPlugins = vi.fn();
    renderWithQuery(
      <PluginAppView
        binding={{
          ...binding,
          presentation: {
            pluginName: "Field Notes",
            entryTitle: "Field Notes",
            target: {
              pluginId,
              pluginName: "workbench-field-notes",
              marketplace: { kind: "local", marketplacePath: "/plugins/marketplace.json" },
            },
          },
        }}
        onOpenPlugins={onOpenPlugins}
      />,
    );
    await screen.findByText("This app is no longer available here.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open in Plugins" })));
    expect(onOpenPlugins).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(pluginId)),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(open).toHaveBeenCalledTimes(2);
  },
);
