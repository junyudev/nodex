import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  FolderPluginPreview,
  FolderPluginPreviewResult,
} from "../../../../shared/codex-plugin-management";
import { usePluginManagement, type PluginManagement } from "../plugin-management";
import { useAddPluginFromFolder } from "./folder-plugin-dialog";

vi.mock("../plugin-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-management")>()),
  usePluginManagement: vi.fn(),
}));

vi.mock("@/lib/query-options", () => ({
  localPathPresentationContextQueryOptions: () => ({
    queryKey: ["path-context"],
    queryFn: async () => ({ homeDirectory: "/Users/me", separator: "/" }),
  }),
}));

const context = { hostId: "local", projectId: null } as const;
const folder = "/Users/me/plugins/notes";

const preview: FolderPluginPreview = {
  stagingId: "11111111-1111-4111-8111-111111111111",
  folder,
  name: "notes",
  displayName: "Field Notes",
  description: "Keeps field notes in the Project.",
  version: "1.2.0",
  developer: "Ada",
  logoUrl: null,
  skills: [{ name: "summarize-notes", description: "Summarize notes" }],
  mcpServers: [{ key: "notes", launch: "node server.mjs" }],
  hookCount: 0,
  connectedAppCount: 0,
  agentSupport: { outsideCodex: "full", limitations: [] },
  replacesPluginId: null,
  warnings: [],
};

const success = <T,>(value: T) => ({
  status: "success" as const,
  value,
  refreshFailures: [],
});

let management: {
  pickFolder: ReturnType<typeof vi.fn>;
  prepareFolder: ReturnType<typeof vi.fn>;
  installFolder: ReturnType<typeof vi.fn>;
  discardFolder: ReturnType<typeof vi.fn>;
};

function Host({ onInstalled }: { readonly onInstalled: (pluginId: string) => void }) {
  const { start, dialog } = useAddPluginFromFolder(context, ({ pluginId }) =>
    onInstalled(pluginId),
  );
  return (
    <>
      <button type="button" onClick={start}>
        From folder
      </button>
      {dialog}
    </>
  );
}

function renderHost(onInstalled = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Host onInstalled={onInstalled} />
    </QueryClientProvider>,
  );
  return onInstalled;
}

async function openReview(result: FolderPluginPreviewResult) {
  management.prepareFolder.mockResolvedValue(success(result));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "From folder" }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  management = {
    pickFolder: vi.fn(async () => folder),
    prepareFolder: vi.fn(),
    installFolder: vi.fn(async () =>
      success({
        pluginId: "notes@nodex-local",
        selector: { marketplacePath: "/catalog.json", pluginName: "notes" },
      }),
    ),
    discardFolder: vi.fn(async () => undefined),
  };
  vi.mocked(usePluginManagement).mockReturnValue(management as unknown as PluginManagement);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("installs exactly the reviewed copy", async () => {
  const onInstalled = renderHost();
  await openReview({ status: "ready", preview });

  expect(await screen.findByText("Field Notes")).toBeTruthy();
  expect(screen.getByText("summarize-notes")).toBeTruthy();
  expect(screen.getByText("node server.mjs")).toBeTruthy();
  expect(management.prepareFolder).toHaveBeenCalledWith({ folder });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await Promise.resolve();
  });

  await waitFor(() => expect(onInstalled).toHaveBeenCalledWith("notes@nodex-local"));
  expect(management.installFolder).toHaveBeenCalledWith({ stagingId: preview.stagingId });
  expect(management.discardFolder).not.toHaveBeenCalled();
});

it("discards the reviewed copy when the review is cancelled", async () => {
  renderHost();
  await openReview({ status: "ready", preview });
  await screen.findByText("Field Notes");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await Promise.resolve();
  });

  expect(management.discardFolder).toHaveBeenCalledWith({ stagingId: preview.stagingId });
  expect(management.installFolder).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByText("Field Notes")).toBeNull());
});

it("explains why a folder is not a plugin", async () => {
  renderHost();
  await openReview({ status: "rejected", folder, reasons: ["The folder has no plugin manifest."] });

  expect(await screen.findByText("This folder isn’t a plugin")).toBeTruthy();
  expect(screen.getByText("The folder has no plugin manifest.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
});

it("keeps the review open when installing fails, so the person can try again", async () => {
  const onInstalled = renderHost();
  management.installFolder.mockResolvedValueOnce({
    status: "failed",
    error: {
      code: "service_unavailable",
      message: "Codex couldn’t add the plugin.",
      retryable: true,
    },
  });
  await openReview({ status: "ready", preview });
  await screen.findByText("Field Notes");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await Promise.resolve();
  });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Codex couldn’t add the plugin.")).toBeTruthy();
  expect(management.discardFolder).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(onInstalled).toHaveBeenCalledWith("notes@nodex-local"));
  expect(management.installFolder).toHaveBeenCalledTimes(2);
});
