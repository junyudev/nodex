import { createFileSearchFixture } from "../../test/file-search-fixture";
import { afterAll, beforeAll, beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderWithMaitai } from "../../test/thread-maitai";
import { settleAsyncRender } from "../../test/dom";
import { installWindowApi } from "../../test/browser-globals";
import { createTestQueryClient, TestQueryProvider } from "../../test/query";
import type { FileReferenceRouterPort } from "@/lib/file-reference-router";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { Project, ProjectSession, WorkspaceFileDirectoryEntry } from "@/lib/types";
import { WORKSPACE_TEXT_LOAD_MAX_BYTES } from "./workspace-file-model";
import type { WorkspaceFilesTab } from "./workspace-file-types";

let WorkspaceFilesPanel: (typeof import("./workspace-files-panel"))["WorkspaceFilesPanel"];
let invokeCalls: unknown[][] = [];
let openFileTabCalls: {
  path: string;
  title: string;
  panelId: WorkspaceFilesTab["panelId"];
  mode: "preview" | "durable";
}[] = [];

const WORKSPACE_ROOT = "/workspace";
const WORKTREE_FILE = "/profile/worktrees/abcd/project/README.md";
const HUGE_FILE = "/profile/worktrees/abcd/project/huge.txt";
const LARGE_MARKDOWN_FILE = `${WORKSPACE_ROOT}/large.md`;
const LARGE_PDF_FILE = `${WORKSPACE_ROOT}/large-design.pdf`;
const IMAGE_FILE = `${WORKSPACE_ROOT}/diagram.png`;
const REMOTE_HOST = "remote-ssh-discovered:win";
let remoteSizeBytes: number | null = null;
let remoteTextRead: (() => Promise<{ contents: string }>) | null = null;
let remoteBinaryRead: (() => Promise<{ contentsBase64: string; mimeType: string }>) | null = null;
const remoteContents: Record<string, string> = {
  [`${WORKSPACE_ROOT}/src/index.ts`]: "export const remote = 2;\n",
  [`${WORKSPACE_ROOT}/README.md`]: `# Remote\n\n[Source](${WORKSPACE_ROOT}/src/index.ts#L2)`,
};
const CREATED_AT = "2026-06-13T00:00:00.000Z";
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const createObjectURLMock = vi.fn((_blob: Blob) => "blob:nodex-workspace-preview");
const revokeObjectURLMock = vi.fn((_url: string) => undefined);

Object.defineProperties(URL, {
  createObjectURL: { configurable: true, value: createObjectURLMock },
  revokeObjectURL: { configurable: true, value: revokeObjectURLMock },
});

const directoryEntries: Record<string, WorkspaceFileDirectoryEntry[]> = {
  "": [
    entry("src", "src", "directory"),
    entry("README.md", "README.md", "file"),
    entry("archive.zip", "archive.zip", "file"),
  ],
  src: [entry("index.ts", "src/index.ts", "file")],
};

const fileContents: Record<string, string> = {
  [`${WORKSPACE_ROOT}/README.md`]: "# Project\n\nWorkspace notes.",
  [`${WORKSPACE_ROOT}/src/index.ts`]: "export const value = 1;\n",
  [`${WORKSPACE_ROOT}/LICENSE`]: "MIT License\n",
  [`${WORKSPACE_ROOT}/notes.txt`]: "Plain notes.\n",
  [WORKTREE_FILE]: "# Project\n\nWorktree notes.",
  [LARGE_MARKDOWN_FILE]: `# Large\n\n${"linked content\n".repeat(20_000)}`,
};

let fileSearch = createFileSearchFixture(Object.values(directoryEntries).flat());

interface GitWorkerTestRequest {
  readonly method: string;
  readonly params: { readonly cwd: string; readonly source?: string };
}

const notARepository = async ({ params }: GitWorkerTestRequest) => ({
  cwd: params.cwd,
  root: null,
  gitDir: null,
  commonDir: null,
  isGitRepository: false,
  currentBranch: null,
  defaultBranch: null,
  errorMessage: null,
  originUrl: null,
});
let gitWorkerRequest: (request: GitWorkerTestRequest) => Promise<unknown> = notARepository;

/** A repository at the workspace root where `src/index.ts` has one unstaged edit. */

const invoke = async (channel: string, ...args: unknown[]) => {
  invokeCalls.push([channel, ...args]);
  if (channel === "workspace-directory-entries") {
    const input = args[0] as { directoryPath?: string };
    const directoryPath = input.directoryPath ?? "";
    return {
      directoryPath,
      parentPath: directoryPath ? "" : null,
      entries: directoryEntries[directoryPath] ?? [],
    };
  }
  if (channel === "read-file-metadata") {
    const input = args[0] as { hostId?: string; path: string };
    const unsupported = input.path.endsWith(".zip");
    const pdf = input.path.endsWith(".pdf");
    const image = input.path.endsWith(".png");
    if (input.path.endsWith(".webm")) {
      return {
        isFile: true,
        sizeBytes: 241_603,
        createdAtMs: Date.parse(CREATED_AT),
        mtimeMs: Date.parse(CREATED_AT),
        contentKind: "video",
        mimeType: "video/webm",
      };
    }
    return {
      isFile: true,
      sizeBytes:
        input.hostId === REMOTE_HOST
          ? remoteSizeBytes
          : input.path === HUGE_FILE
            ? WORKSPACE_TEXT_LOAD_MAX_BYTES + 1
            : unsupported
              ? 12_000
              : input.path === LARGE_PDF_FILE
                ? 25_000_001
                : pdf || image
                  ? 8
                  : (fileContents[input.path]?.length ?? 0),
      createdAtMs: Date.parse(CREATED_AT),
      mtimeMs: Date.parse(CREATED_AT),
      contentKind: unsupported ? "archive" : pdf ? "pdf" : image ? "image" : "text",
      mimeType: pdf ? "application/pdf" : image ? "image/png" : undefined,
    };
  }
  if (channel === "read-file-binary") {
    const input = args[0] as { hostId?: string; path: string };
    if (input.hostId === REMOTE_HOST && remoteBinaryRead) return remoteBinaryRead();
    return {
      contentsBase64: "JVBERi0xLjQ=",
      mimeType: input.path.endsWith(".png") ? "image/png" : "application/pdf",
    };
  }
  if (channel.startsWith("file-search:")) return fileSearch.invoke(channel, args[0]);
  if (channel === "shell:file-link-openers:list-available") return ["vscode", "fileManager"];
  if (channel === "shell:open-path-default") return true;
  if (channel === "file-open-applications") return { defaultApplication: null, applications: [] };
  if (channel === "read-file") {
    const input = args[0] as { hostId?: string; path: string };
    if (input.hostId === REMOTE_HOST && remoteTextRead) return remoteTextRead();
    const content =
      (input.hostId === REMOTE_HOST ? remoteContents : fileContents)[input.path] ?? "";
    return {
      contents: content,
    };
  }
  if (channel === "workspace-file-watch:start") {
    return { subscriptionId: "00000000-0000-4000-8000-000000000001" };
  }
  if (channel === "workspace-file-watch:stop") return undefined;
  if (channel === "write-file") {
    return { outcome: "saved", mtimeMs: Date.parse(CREATED_AT) + 1 };
  }
  if (
    channel === "open-file" ||
    channel === "shell:open-file-link" ||
    channel === "shell:open-external-url"
  ) {
    return true;
  }
  throw new Error(`Unexpected channel: ${channel}`);
};

vi.mock("@/lib/api", () => ({
  subscribeBoardChanges: () => () => undefined,
  subscribeProjectSessionChanges: () => () => undefined,
  subscribeProjectChanges: () => () => undefined,
  subscribeCodexHostMessages: () => () => undefined,
  subscribeDesktopNotificationActions: () => () => undefined,
  subscribeWorkspaceFileChanges: () => () => undefined,
  subscribeAppUpdateStatus: () => () => undefined,
  getWindowFocusState: async () => true,
  subscribeWindowFocusChanges: () => () => undefined,
  getGitWorkerClient: () => ({
    subscribe: () => () => undefined,
    request: (request: GitWorkerTestRequest) => gitWorkerRequest(request),
  }),
}));

// The editor has its own Chromium coverage; here it reports what the panel hands it.
vi.mock("./workspace-pierre-editor", () => ({
  WorkspacePierreEditor: (props: {
    ariaLabel: string;
    value: string;
    comparison?: { oldContent: string; layout: string } | null;
  }) => (
    <section
      role="region"
      aria-label={props.ariaLabel}
      data-comparison-base={props.comparison?.oldContent}
      data-comparison-layout={props.comparison?.layout}
    >
      {props.value}
    </section>
  ),
}));

vi.mock("./workspace-file-tree", () => ({
  WorkspaceFileTree: ({
    paths,
    expandedPaths,
    initialScrollTop,
    selectedPath,
    searchQuery,
    onOpen,
    onExpansionChange,
    onScrollTopChange,
  }: {
    paths: Array<{ path: string; kind: "directory" | "file" }>;
    expandedPaths: readonly string[];
    initialScrollTop?: number;
    selectedPath: string | null;
    searchQuery: string;
    onOpen: (path: string, mode: "preview" | "durable") => void;
    onExpansionChange: (expansion: { expandedPaths: readonly string[] }) => void;
    onScrollTopChange?: (scrollTop: number) => void;
  }) => (
    <div
      role="tree"
      aria-label="Workspace files"
      data-initial-scroll-top={initialScrollTop}
      data-selected-path={selectedPath}
    >
      <button type="button" onClick={() => onScrollTopChange?.(420)}>
        Scroll tree
      </button>
      {paths
        .filter(
          (item) => !searchQuery || item.path.toLowerCase().includes(searchQuery.toLowerCase()),
        )
        .map((item) => (
          <button
            type="button"
            key={item.path}
            onClick={() => {
              if (item.kind === "directory") {
                onExpansionChange({
                  expandedPaths: [...expandedPaths.filter(Boolean), item.path],
                });
                return;
              }
              onOpen(item.path, "preview");
            }}
            onDoubleClick={() => {
              if (item.kind === "file") onOpen(item.path, "durable");
            }}
          >
            {item.path.split("/").at(-1)}
          </button>
        ))}
    </div>
  ),
}));

vi.mock("@/components/ui/lazy-source-viewer", () => ({
  LazySourceViewer: ({ ariaLabel, value }: { ariaLabel: string; value: string }) => (
    <pre data-source-viewer="true" aria-label={ariaLabel}>
      {value}
    </pre>
  ),
}));

vi.mock("./workspace-pdf-preview", () => ({
  WorkspacePdfPreview: (props: {
    fileDataUrl: string;
    title: string;
    onOpenExternalLink: (url: string) => void;
  }) => {
    return (
      <button
        type="button"
        aria-label={`PDF preview for ${props.title}`}
        data-file-data-url={props.fileDataUrl}
        onClick={() => props.onOpenExternalLink("https://example.com/spec")}
      >
        PDF preview
      </button>
    );
  },
}));

beforeAll(async () => {
  const module = await import("./workspace-files-panel");
  WorkspaceFilesPanel = module.WorkspaceFilesPanel;
  // Video tests observe the viewer, not the player's lazy module load.
  await import("@/components/conversation-media/conversation-video-player");
});

afterAll(() => {
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: originalCreateObjectURL },
    revokeObjectURL: { configurable: true, value: originalRevokeObjectURL },
  });
});

beforeEach(() => {
  fileSearch = createFileSearchFixture(Object.values(directoryEntries).flat());
  installWindowApi({ invoke, on: fileSearch.on });
  invokeCalls = [];
  openFileTabCalls = [];
  createObjectURLMock.mockClear();
  revokeObjectURLMock.mockClear();
  remoteSizeBytes = null;
  remoteTextRead = null;
  remoteBinaryRead = null;
  gitWorkerRequest = notARepository;
});

describe("WorkspaceFilesPanel", () => {
  test("previews unknown-size remote text without local editing, watching, browsing or open fallback", async () => {
    const view = renderRemotePanel(`${WORKSPACE_ROOT}/src/index.ts`);
    expect((await view.findByLabelText("Source preview for index.ts")).textContent).toBe(
      remoteContents[`${WORKSPACE_ROOT}/src/index.ts`],
    );
    expect(view.queryByLabelText("Source editor for index.ts")).toBeNull();
    expect(view.queryByRole("button", { name: "Open" })).toBeNull();
    expect(view.queryByRole("tree")).toBeNull();
    const reads = invokeCalls.filter((call) =>
      ["read-file", "read-file-metadata"].includes(String(call[0])),
    );
    expect(reads).toHaveLength(2);
    expect(reads.every((call) => (call[1] as { hostId: string }).hostId === REMOTE_HOST)).toBe(
      true,
    );
    expect(
      invokeCalls.some((call) =>
        [
          "workspace-file-watch:start",
          "write-file",
          "workspace-directory-entries",
          "shell:open-file-link",
        ].includes(String(call[0])),
      ),
    ).toBe(false);
    view.unmount();
    await settleAsyncRender();
    expect(
      invokeCalls.some(
        (call) => call[0] === "write-file" || call[0] === "workspace-file-watch:stop",
      ),
    ).toBe(false);
  });

  test("keeps rendered remote Markdown links on their host and rejects modified local opens", async () => {
    remoteSizeBytes = 64;
    const open = vi.fn<FileReferenceRouterPort["openWorkspaceFileTab"]>(async () => true);
    const view = renderRemotePanel(`${WORKSPACE_ROOT}/README.md`, open);
    const source = await view.findByRole("button", { name: "Source" });
    await act(async () => {
      fireEvent.click(source);
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: REMOTE_HOST,
        path: `${WORKSPACE_ROOT}/src/index.ts`,
        location: { line: 2 },
      }),
    );
    expect(invokeCalls.some((call) => call[0] === "workspace-file-watch:start")).toBe(false);
    open.mockClear();
    await act(async () => {
      fireEvent.doubleClick(source);
      await Promise.resolve();
    });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: REMOTE_HOST,
        path: `${WORKSPACE_ROOT}/src/index.ts`,
        mode: "durable",
      }),
    );
    open.mockClear();
    await act(async () => {
      fireEvent.click(
        source,
        /^(mac|darwin)/iu.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true },
      );
      await Promise.resolve();
    });
    expect(open).not.toHaveBeenCalled();
    expect(invokeCalls.some((call) => call[0] === "shell:open-file-link")).toBe(false);
  });

  test("loads embedded Markdown images and picture candidates through the source host", async () => {
    const path = `${WORKSPACE_ROOT}/README.md`;
    const previous = remoteContents[path]!;
    remoteContents[path] =
      `![Embedded](./images/chart.png)\n\n<picture><source srcset="app://fs/@fs/tmp/local-sentinel.png 1x, ./wide.png 2x"><img src="/workspace/base.png" alt="Picture"></picture>`;
    const view = renderRemotePanel(path);
    try {
      await waitFor(() =>
        expect(view.getByAltText("Embedded").getAttribute("src")).toBe(
          "blob:nodex-workspace-preview",
        ),
      );
      await waitFor(() =>
        expect(view.container.querySelector("source")?.getAttribute("srcset")).toBe(
          "blob:nodex-workspace-preview 2x",
        ),
      );
      await waitFor(() =>
        expect(view.getByAltText("Picture").getAttribute("src")).toBe(
          "blob:nodex-workspace-preview",
        ),
      );
      expect(invokeCalls.filter(([channel]) => channel === "read-file-binary")).toEqual(
        expect.arrayContaining([
          ["read-file-binary", { hostId: REMOTE_HOST, path: "/workspace/images/chart.png" }],
          ["read-file-binary", { hostId: REMOTE_HOST, path: "/workspace/wide.png" }],
          ["read-file-binary", { hostId: REMOTE_HOST, path: "/workspace/base.png" }],
        ]),
      );
      expect(
        invokeCalls.some(
          ([, input]) =>
            typeof input === "object" &&
            input !== null &&
            "hostId" in input &&
            input.hostId === "local",
        ),
      ).toBe(false);
      for (const media of view.container.querySelectorAll("img, source")) {
        expect(media.getAttribute("src") ?? "").not.toMatch(/app:|\/@fs|sentinel/u);
        expect(media.getAttribute("srcset") ?? "").not.toMatch(/app:|\/@fs|sentinel/u);
      }
    } finally {
      remoteContents[path] = previous;
      view.unmount();
      await settleAsyncRender();
    }
    expect(revokeObjectURLMock.mock.calls).toHaveLength(3);
  });

  test.each([`${WORKSPACE_ROOT}/src/index.ts`, IMAGE_FILE])(
    "refreshes remote %s twice through the real query cache",
    async (path) => {
      let reads = 0;
      const binary = path === IMAGE_FILE;
      if (binary)
        remoteBinaryRead = async () => ({
          contentsBase64: window.btoa("x".repeat(++reads)),
          mimeType: "image/png",
        });
      else remoteTextRead = async () => ({ contents: `remote version ${++reads}` });
      const view = renderRemotePanel(path);
      try {
        for (let expected = 1; expected <= 3; expected += 1) {
          await waitFor(() => expect(reads).toBe(expected));
          if (binary)
            await waitFor(() => expect(createObjectURLMock.mock.calls).toHaveLength(expected));
          else
            await waitFor(() =>
              expect(view.getByLabelText("Source preview for index.ts").textContent).toBe(
                `remote version ${expected}`,
              ),
            );
          if (expected === 3) break;
          await act(async () => {
            fireEvent.click(view.getByRole("button", { name: "File viewer options" }));
            await Promise.resolve();
          });
          const refresh = await view.findByRole("menuitem", { name: "Refresh files" });
          await act(async () => {
            fireEvent.click(refresh);
            await Promise.resolve();
          });
        }
        const channel = binary ? "read-file-binary" : "read-file";
        expect(invokeCalls.filter(([name]) => name === channel)).toHaveLength(3);
        if (binary)
          expect(createObjectURLMock.mock.calls.map(([blob]) => blob.size)).toEqual([1, 2, 3]);
      } finally {
        view.unmount();
        await settleAsyncRender();
      }
      if (binary) expect(revokeObjectURLMock.mock.calls).toHaveLength(3);
    },
  );

  test("fences a late remote read when the same path changes to a different host", async () => {
    const pending = deferred<{ contents: string }>();
    remoteTextRead = () => pending.promise;
    const path = `${WORKSPACE_ROOT}/src/index.ts`;
    const otherHost = "remote-ssh-discovered:linux";
    const client = createTestQueryClient();
    const body = (hostId: string) => (
      <TestQueryProvider client={client}>
        <NodexTooltipProvider>
          <WorkspaceFilesPanel
            tab={makeRemoteFilesTab(path, hostId)}
            project={project}
            activeSession={activeSession}
            onOpenFileTab={async () => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>
    );
    const view = renderWithMaitai(body(REMOTE_HOST));
    await waitFor(() =>
      expect(invokeCalls).toContainEqual([
        "read-file",
        { hostId: REMOTE_HOST, path, maxBytes: WORKSPACE_TEXT_LOAD_MAX_BYTES },
      ]),
    );
    view.rerender(body(otherHost));
    const source = await view.findByLabelText("Source preview for index.ts");
    expect(source.textContent).toBe(fileContents[path]);
    await act(async () => {
      pending.resolve({ contents: "stale remote bytes" });
      await pending.promise;
    });
    expect(view.getByLabelText("Source preview for index.ts").textContent).toBe(fileContents[path]);
    expect(invokeCalls).toContainEqual([
      "read-file-metadata",
      expect.objectContaining({ hostId: otherHost, path }),
    ]);
  });

  test("previews a projectless exact file without requesting a directory tree", async () => {
    const tab = makeFilesTab(WORKTREE_FILE);
    const view = renderWithMaitai(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <WorkspaceFilesPanel
            tab={{
              ...tab,
              projectId: null,
              config: {
                ...tab.config,
                projectId: null,
                cwd: "/profile/worktrees/abcd/project",
                workspaceRoot: null,
              },
            }}
            activeSession={{ ...activeSession, projectId: null }}
            project={null}
            onOpenFileTab={async () => undefined}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await settleAsyncRender();
    await settleAsyncRender();

    expect(view.getByText("Worktree notes.") !== null).toBe(true);
    expect(invokeCalls.some((call) => call[0] === "workspace-directory-entries")).toBe(false);
  });

  test("uses metadata to reject oversized text before reading full contents", async () => {
    const view = renderPanel(HUGE_FILE);
    await settleAsyncRender();
    await settleAsyncRender();

    expect(view.getByText("File is too large to preview")).not.toBeNull();
    expect(view.getByText("20.0 MB exceeds the 20.0 MB preview limit")).not.toBeNull();
    expect(invokeCalls.some((call) => call[0] === "read-file")).toBe(false);
  });

  test("keeps raster previews on revocable object URLs", async () => {
    const view = renderPanel(IMAGE_FILE);
    await settleAsyncRender();
    await settleAsyncRender();

    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:nodex-workspace-preview",
    );
    expect(createObjectURLMock).toHaveBeenCalledOnce();
    expect(createObjectURLMock.mock.calls[0]?.[0].type).toBe("image/png");

    view.unmount();
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:nodex-workspace-preview");
  });

  test("restores expanded directory queries after the selected Files body remounts", async () => {
    function RemountHarness() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setMounted((current) => !current)}>
            Toggle panel
          </button>
          {mounted ? (
            <WorkspaceFilesPanel
              tab={makeFilesTab()}
              activeSession={activeSession}
              project={project}
              onOpenFileTab={async () => undefined}
            />
          ) : null}
        </>
      );
    }

    const view = renderWithMaitai(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <RemountHarness />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    await settleAsyncRender();
    await settleAsyncRender();

    fireEvent.click(view.getByText("src"));
    // The folder's listing arrives as its own query result, after the expansion renders.
    expect(await view.findByText("index.ts")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Scroll tree" }));
    fireEvent.input(view.getByRole("textbox", { name: "Filter files" }), {
      target: { value: "index" },
    });
    await settleAsyncRender();

    fireEvent.click(view.getByRole("button", { name: "Toggle panel" }));
    await settleAsyncRender();
    fireEvent.click(view.getByRole("button", { name: "Toggle panel" }));
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => expect(view.getByText("index.ts")).not.toBeNull());
    expect((view.getByRole("textbox", { name: "Filter files" }) as HTMLInputElement).value).toBe(
      "index",
    );
    expect(
      view.getByRole("tree", { name: "Workspace files" }).getAttribute("data-initial-scroll-top"),
    ).toBe("420");

    // Unfiltered, the file is listed only because its folder is still expanded.
    fireEvent.input(view.getByRole("textbox", { name: "Filter files" }), {
      target: { value: "" },
    });
    expect(await view.findByText("README.md")).not.toBeNull();
    expect(view.getByText("index.ts")).not.toBeNull();
  });
});

function renderPanel(selectedPath?: string) {
  return renderWithMaitai(
    <TestQueryProvider>
      <NodexTooltipProvider>
        <WorkspaceFilesPanel
          tab={makeFilesTab(selectedPath)}
          activeSession={activeSession}
          project={project}
          onOpenFileTab={async (input) => {
            openFileTabCalls.push(input);
          }}
        />
      </NodexTooltipProvider>
    </TestQueryProvider>,
  );
}

function makeRemoteFilesTab(path: string, hostId = REMOTE_HOST): WorkspaceFilesTab {
  const tab = makeFilesTab(path);
  return { ...tab, config: { ...tab.config, hostId, workspaceRoot: null } };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function renderRemotePanel(
  path: string,
  openWorkspaceFileTab: FileReferenceRouterPort["openWorkspaceFileTab"] = vi.fn(async () => true),
) {
  return renderWithMaitai(
    <TestQueryProvider>
      <NodexTooltipProvider>
        <WorkspaceFilesPanel
          tab={makeRemoteFilesTab(path)}
          project={project}
          activeSession={activeSession}
          onOpenFileTab={openWorkspaceFileTab}
        />
      </NodexTooltipProvider>
    </TestQueryProvider>,
  );
}

function makeFilesTab(selectedPath?: string): WorkspaceFilesTab {
  return {
    id: "files-tab",
    sessionId: activeSession.id,
    projectId: project.id,
    browserTabId: null,
    panelId: "right",
    kind: "files",
    title: selectedPath ? (selectedPath.split("/").at(-1) ?? "Files") : "Files",
    order: 0,
    config: {
      projectId: project.id,
      hostId: "local",
      cwd: WORKSPACE_ROOT,
      workspaceRoot: WORKSPACE_ROOT,
      ...(selectedPath ? { path: selectedPath } : {}),
    },
    stateKey: 0,
    state: { richView: true },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function entry(
  name: string,
  path: string,
  kind: "directory" | "file",
): WorkspaceFileDirectoryEntry {
  return {
    name,
    path,
    type: kind,
    isSymlink: false,
  };
}

const project: Project = {
  id: "alpha",
  libraryId: "library:test",
  databaseId: "database:test:primary",
  defaultDatabaseViewId: "view:test:primary",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Alpha",
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [{ kind: "directory" as const, path: WORKSPACE_ROOT, order: 0 }],
  primaryWorkspaceRoot: WORKSPACE_ROOT,
  pinned: false,
  pinnedOrder: null,
  created: new Date(CREATED_AT),
  updated: new Date(CREATED_AT),
};

const activeSession: ProjectSession = {
  id: "session-1",
  projectId: project.id,
  noThreadFallbackTitle: "Session",
  displayTitle: "Session",
  activityAt: 0,
  managed: false,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  wokeAt: null,
  pageTurn: null,
  canManage: true,
  canStop: true,
  unread: false,
  thread: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};
