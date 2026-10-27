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
let pdfPreviewProps: { fileDataUrl: string; onOpenExternalLink: (url: string) => void } | null =
  null;

const WORKSPACE_ROOT = "/workspace";
const WORKTREE_FILE = "/profile/worktrees/abcd/project/README.md";
const HUGE_FILE = "/profile/worktrees/abcd/project/huge.txt";
const LARGE_MARKDOWN_FILE = `${WORKSPACE_ROOT}/large.md`;
const PDF_FILE = `${WORKSPACE_ROOT}/design.pdf`;
const LARGE_PDF_FILE = `${WORKSPACE_ROOT}/large-design.pdf`;
const IMAGE_FILE = `${WORKSPACE_ROOT}/diagram.png`;
const VIDEO_FILE = `${WORKSPACE_ROOT}/clips/review #1.webm`;
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
const repositoryWithUnstagedEdit = async ({ method, params }: GitWorkerTestRequest) => {
  if (method === "stable-metadata")
    return {
      cwd: params.cwd,
      root: WORKSPACE_ROOT,
      gitDir: `${WORKSPACE_ROOT}/.git`,
      commonDir: `${WORKSPACE_ROOT}/.git`,
      isGitRepository: true,
      currentBranch: "main",
      defaultBranch: "main",
      errorMessage: null,
      originUrl: null,
    };
  if (method === "review-summary")
    return {
      type: "success",
      source: params.source,
      files:
        params.source === "unstaged"
          ? [
              {
                path: "src/index.ts",
                previousPath: null,
                status: "modified",
                rawStatus: "M",
                oldOid: "base-oid",
                newOid: null,
                revision: "1",
                additions: 1,
                deletions: 1,
                safety: {
                  binary: false,
                  tooLarge: false,
                  invalidText: false,
                  renderable: true,
                  sizeBytes: 24,
                  mimeType: null,
                },
              },
            ]
          : [],
      snapshotGeneration: 1,
      stageCounts: { stagedFileCount: 0, unstagedFileCount: 1, untrackedFileCount: 0 },
      untrackedFilesOmitted: 0,
    };
  if (method === "review-cat-file")
    return {
      type: "success",
      value: {
        snapshotGeneration: 1,
        results: [{ type: "success", lines: ["export const value = 0;\n"] }],
      },
    };
  if (method === "base-branch")
    return { cwd: params.cwd, local: "main", remote: null, errorMessage: null };
  throw new Error(`Unexpected Git request: ${method}`);
};

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
    onStateChange,
  }: {
    paths: Array<{ path: string; kind: "directory" | "file" }>;
    expandedPaths: ReadonlySet<string>;
    initialScrollTop?: number;
    selectedPath: string | null;
    searchQuery: string;
    onOpen: (path: string, mode: "preview" | "durable") => void;
    onStateChange?: (state: {
      expandedPaths: readonly string[];
      selectedPath: string | null;
      scrollTop: number;
    }) => void;
  }) => (
    <div
      role="tree"
      aria-label="Workspace files"
      data-initial-scroll-top={initialScrollTop}
      data-selected-path={selectedPath}
    >
      <button
        type="button"
        onClick={() =>
          onStateChange?.({
            expandedPaths: [...expandedPaths],
            selectedPath,
            scrollTop: 420,
          })
        }
      >
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
                onStateChange?.({
                  expandedPaths: [...expandedPaths, item.path],
                  selectedPath,
                  scrollTop: initialScrollTop ?? 0,
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
    pdfPreviewProps = props;
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
  await import("@/lib/conversation-media/conversation-video-player");
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
  pdfPreviewProps = null;
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
      fireEvent.click(source, { metaKey: true });
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

  test("surfaces a failed remote read without opening the same local path", async () => {
    remoteTextRead = async () => {
      throw new Error("Remote host disconnected");
    };
    const view = renderRemotePanel(`${WORKSPACE_ROOT}/src/index.ts`);
    expect(await view.findByText("Remote host disconnected")).not.toBeNull();
    expect(
      invokeCalls
        .filter((call) => String(call[0]).startsWith("read-file"))
        .every((call) => (call[1] as { hostId: string }).hostId === REMOTE_HOST),
    ).toBe(true);
    expect(
      invokeCalls.some(
        (call) => call[0] === "shell:open-file-link" || call[0] === "workspace-file-watch:start",
      ),
    ).toBe(false);
  });

  test.each([PDF_FILE, IMAGE_FILE])(
    "reads remote binary bytes with source host: %s",
    async (path) => {
      const view = renderRemotePanel(path);
      await waitFor(() =>
        expect(invokeCalls).toContainEqual(["read-file-binary", { hostId: REMOTE_HOST, path }]),
      );
      if (path === PDF_FILE) {
        expect(
          await view.findByRole("button", { name: "PDF preview for design.pdf" }),
        ).not.toBeNull();
      } else {
        await waitFor(() =>
          expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
            "blob:nodex-workspace-preview",
          ),
        );
      }
      expect(
        invokeCalls.some(
          (call) =>
            call[0] === "workspace-directory-entries" || call[0] === "workspace-file-watch:start",
        ),
      ).toBe(false);
      view.unmount();
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

  test("shows a text file's changes against its working-tree baseline and hides them again", async () => {
    gitWorkerRequest = repositoryWithUnstagedEdit;
    const view = renderPanel(`${WORKSPACE_ROOT}/src/index.ts`);
    fireEvent.click(await view.findByRole("button", { name: "Show changes" }));

    const source = await view.findByRole("group", { name: "Review source" });
    await waitFor(() => expect(source.textContent).toBe("Unstaged"));
    const editor = view.getByRole("region", { name: "Source editor for index.ts" });
    await waitFor(() =>
      expect(editor.getAttribute("data-comparison-base")).toBe("export const value = 0;\n"),
    );
    expect(editor.getAttribute("data-comparison-layout")).toBe("unified");
    expect(view.getByRole("button", { name: "Switch to split diff" })).not.toBeNull();
    // The editable header carries comparison controls instead of the viewer's path actions.
    expect(view.queryByRole("button", { name: "File viewer options" })).toBeNull();
    expect(view.queryByRole("group", { name: "Copy repo-relative path" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Hide changes" }));
    expect(await view.findByRole("button", { name: "Show changes" })).not.toBeNull();
    expect(view.queryByRole("group", { name: "Review source" })).toBeNull();
    expect(editor.getAttribute("data-comparison-base")).toBeNull();
  });

  test("renders the tree filter and opens files through preview tabs", async () => {
    const view = renderPanel();
    await settleAsyncRender();
    await settleAsyncRender();

    expect(view.getByPlaceholderText("Filter files…") !== null).toBe(true);
    expect(view.getByText("README.md") !== null).toBe(true);
    expect(view.getByText("archive.zip") !== null).toBe(true);

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.input(view.getByPlaceholderText("Filter files…"), { target: { value: "read" } });
        await vi.advanceTimersByTimeAsync(175);
      });
    } finally {
      vi.useRealTimers();
    }
    await settleAsyncRender();
    expect(view.getByText("README.md") !== null).toBe(true);
    expect(view.queryByText("archive.zip")).toBe(null);

    fireEvent.click(view.getByText("README.md"));
    await settleAsyncRender();

    expect(JSON.stringify(openFileTabCalls)).toBe(
      JSON.stringify([
        {
          hostId: "local",
          path: `${WORKSPACE_ROOT}/README.md`,
          title: "README.md",
          panelId: "right",
          mode: "preview",
        },
      ]),
    );
  });

  test("previews an outside-root file while keeping only the directory request root-scoped", async () => {
    const view = renderPanel(WORKTREE_FILE);
    await settleAsyncRender();
    await settleAsyncRender();

    expect(view.getByText("Project") !== null).toBe(true);
    expect(view.getByText("Worktree notes.") !== null).toBe(true);
    const directoryCall = invokeCalls.find((call) => call[0] === "workspace-directory-entries");
    expect(directoryCall?.[1]).toEqual({
      hostId: "local",
      workspaceRoot: WORKSPACE_ROOT,
      directoryPath: "",
      includeHidden: true,
    });
    const fileCalls = invokeCalls.filter((call) =>
      ["read-file-metadata", "read-file"].includes(String(call[0])),
    );
    expect(fileCalls.some((call) => call[0] === "read-file-metadata")).toBe(true);
    expect(fileCalls.some((call) => call[0] === "read-file")).toBe(true);
    expect(fileCalls.every((call) => !JSON.stringify(call[1]).includes("workspaceRoot"))).toBe(
      true,
    );
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

  test("routes large Markdown to its source without mounting the rich renderer", async () => {
    const view = renderPanel(LARGE_MARKDOWN_FILE);
    await settleAsyncRender();
    await settleAsyncRender();

    expect(await view.findByLabelText("Source editor for large.md")).not.toBeNull();
    expect(view.container.querySelector(".codex-markdown-user")).toBe(null);
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "read-file" &&
          (call[1] as { maxBytes?: number }).maxBytes === WORKSPACE_TEXT_LOAD_MAX_BYTES,
      ),
    ).toBe(true);
  });

  test("explains unsupported files and opens them with the system app", async () => {
    const view = renderPanel(`${WORKSPACE_ROOT}/archive.zip`);
    await settleAsyncRender();
    await settleAsyncRender();

    expect(view.getByText("Archive previews aren't supported yet")).not.toBeNull();
    expect(view.getByText("Open this file in another app to view it")).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Open" }));
    await settleAsyncRender();

    expect(JSON.stringify(invokeCalls.at(-1))).toBe(
      JSON.stringify(["shell:open-path-default", `${WORKSPACE_ROOT}/archive.zip`]),
    );
  });

  test("streams a local video into the player without reading its bytes", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const view = renderPanel(VIDEO_FILE);
    await waitFor(() => expect(view.getByLabelText("Video").tagName).toBe("VIDEO"));
    const video = view.getByLabelText("Video");
    expect(video.getAttribute("src")).toBe("app://fs/@fs/workspace/clips/review%20%231.webm");
    expect(view.getByRole("button", { name: "Play video" })).not.toBeNull();
    expect(invokeCalls.some(([channel]) => channel === "read-file-binary")).toBe(false);
    expect(invokeCalls.some(([channel]) => channel === "read-file")).toBe(false);
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
  });

  test("plays remote video from its host's bounded byte read", async () => {
    remoteSizeBytes = 2;
    remoteBinaryRead = async () => ({ contentsBase64: "AQI=", mimeType: "video/webm" });
    const blobs: Blob[] = [];
    createObjectURLMock.mockImplementation((blob: Blob) => {
      blobs.push(blob);
      return "blob:remote-video";
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const view = renderRemotePanel(VIDEO_FILE);
    await waitFor(() =>
      expect(view.getByLabelText("Video").getAttribute("src")).toBe("blob:remote-video"),
    );
    expect(blobs[0]?.type).toBe("video/webm");
    const read = invokeCalls.find(([channel]) => channel === "read-file-binary");
    expect(read?.[1]).toMatchObject({ hostId: REMOTE_HOST, path: VIDEO_FILE });
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    createObjectURLMock.mockImplementation(() => "blob:nodex-workspace-preview");
  });

  test("passes PDF bytes to the dedicated renderer without creating an object URL", async () => {
    const view = renderPanel(PDF_FILE);
    await settleAsyncRender();
    await settleAsyncRender();

    const preview = view.getByRole("button", { name: "PDF preview for design.pdf" });
    expect(preview.getAttribute("data-file-data-url")).toBe(
      "data:application/pdf;base64,JVBERi0xLjQ=",
    );
    expect(pdfPreviewProps?.fileDataUrl).toBe("data:application/pdf;base64,JVBERi0xLjQ=");
    expect(createObjectURLMock).not.toHaveBeenCalled();
    expect(invokeCalls.some((call) => call[0] === "read-file-binary")).toBe(true);

    fireEvent.click(preview);
    await settleAsyncRender();
    expect(invokeCalls).toContainEqual(["shell:open-external-url", "https://example.com/spec"]);

    view.unmount();
    expect(revokeObjectURLMock).not.toHaveBeenCalled();
  });

  test("does not apply the generic raster size threshold to PDF.js documents", async () => {
    const view = renderPanel(LARGE_PDF_FILE);
    await settleAsyncRender();
    await settleAsyncRender();

    expect(view.getByRole("button", { name: "PDF preview for large-design.pdf" })).not.toBeNull();
    expect(invokeCalls.some((call) => call[0] === "read-file-binary")).toBe(true);
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
    await settleAsyncRender();
    expect(view.getByText("index.ts")).not.toBeNull();
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
    expect(
      invokeCalls.filter(
        (call) =>
          call[0] === "workspace-directory-entries" &&
          (call[1] as { directoryPath?: string }).directoryPath === "src",
      ).length,
    ).toBeGreaterThan(0);
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
  sources: [{ root: WORKSPACE_ROOT, order: 0 }],
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
  order: 0,
  pinned: false,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  unread: false,
  thread: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};
