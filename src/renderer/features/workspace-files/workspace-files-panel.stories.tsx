import { createFileSearchFixture } from "../../test/file-search-fixture";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { WorkspaceFilesPanel } from "./workspace-files-panel";
import type { WorkspaceFilesTab } from "./workspace-file-types";
import type { Project, ProjectSession, WorkspaceFileDirectoryEntry } from "@/lib/types";

const WORKSPACE_ROOT = "/Users/asc/repo/nodex";
const WORKTREE_FILE = "/Users/asc/.nodex/worktrees/abcd/nodex/README.md";
const LARGE_MARKDOWN_FILE = `${WORKSPACE_ROOT}/large-notes.md`;
const CREATED_AT = "2026-06-13T00:00:00.000Z";
const EMPTY_WORKSPACE_FILES_TAB_STATE: NonNullable<WorkspaceFilesTab["state"]> = {};
const LARGE_MARKDOWN_SOURCE = Array.from(
  { length: 6_000 },
  (_, index) =>
    `- [Reference ${index + 1}](https://example.com/reference/${index + 1}) keeps exact source available.`,
).join("\n");

const project: Project = {
  id: "nodex",
  libraryId: "library:test",
  databaseId: "database:test:primary",
  defaultDatabaseViewId: "view:test:primary",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Nodex",
  description: "",
  appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
  sources: [{ root: WORKSPACE_ROOT, order: 0 }],
  primaryWorkspaceRoot: WORKSPACE_ROOT,
  pinned: false,
  pinnedOrder: null,
  created: new Date(CREATED_AT),
  updated: new Date(CREATED_AT),
};

const session: ProjectSession = {
  id: "session-files-story",
  projectId: project.id,
  noThreadFallbackTitle: "Files story",
  displayTitle: "Files story",
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

const directoryEntries: Record<string, WorkspaceFileDirectoryEntry[]> = {
  "": [
    entry("src", "src", "directory"),
    entry("README.md", "README.md", "file"),
    entry("large-notes.md", "large-notes.md", "file"),
    entry("CLAUDE.md", "CLAUDE.md", "file"),
  ],
  src: [entry("renderer", "src/renderer", "directory"), entry("main", "src/main", "directory")],
};

const fileContents: Record<string, string> = {
  [`${WORKSPACE_ROOT}/README.md`]: "# Nodex\n\nLocal-first, block-based agent orchestration.",
  [LARGE_MARKDOWN_FILE]: LARGE_MARKDOWN_SOURCE,
  [`${WORKSPACE_ROOT}/CLAUDE.md`]:
    "# Agent Notes\n\nUse the Files tab to inspect workspace documents.",
  [WORKTREE_FILE]: "# Worktree\n\nThis file is outside the Project source and still previews.",
};

const meta = {
  title: "Workspace/Files panel",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const EmptySelection: Story = {
  render: () => <WorkspaceFilesStoryFrame selectedPath={undefined} />,
};

export const MarkdownSelected: Story = {
  render: () => <WorkspaceFilesStoryFrame selectedPath={`${WORKSPACE_ROOT}/README.md`} />,
};

export const MarkdownRendered: Story = {
  render: () => (
    <WorkspaceFilesStoryFrame
      selectedPath={`${WORKSPACE_ROOT}/README.md`}
      tabState={{ markdownMode: "rendered" }}
    />
  ),
};

export const LargeMarkdownSourceFallback: Story = {
  render: () => (
    <WorkspaceFilesStoryFrame
      selectedPath={LARGE_MARKDOWN_FILE}
      tabState={{ markdownMode: "rendered" }}
    />
  ),
};

export const UnsupportedBinary: Story = {
  render: () => <WorkspaceFilesStoryFrame selectedPath={`${WORKSPACE_ROOT}/archive.zip`} />,
};

export const OutsideWorkspaceSelected: Story = {
  render: () => <WorkspaceFilesStoryFrame selectedPath={WORKTREE_FILE} />,
};

export const ProjectlessFile: Story = {
  render: () => <WorkspaceFilesStoryFrame selectedPath={WORKTREE_FILE} workspaceRoot={null} />,
};

function WorkspaceFilesStoryFrame({
  selectedPath,
  tabState = EMPTY_WORKSPACE_FILES_TAB_STATE,
  workspaceRoot = WORKSPACE_ROOT,
}: {
  selectedPath: string | undefined;
  tabState?: WorkspaceFilesTab["state"];
  workspaceRoot?: string | null;
}) {
  const bridgeReady = useMockWorkspaceFilesBridge();
  if (!bridgeReady) return null;
  const projectless = workspaceRoot === null;
  const activeSession = projectless ? { ...session, projectId: null } : session;
  return (
    <div className="h-screen bg-token-main-surface-primary">
      <WorkspaceFilesPanel
        tab={{
          id: "files-tab",
          sessionId: session.id,
          projectId: projectless ? null : project.id,
          browserTabId: null,
          panelId: "right",
          kind: "files",
          title: selectedPath ? (selectedPath.split("/").at(-1) ?? "Files") : "Files",
          order: 0,
          config: {
            projectId: projectless ? null : project.id,
            hostId: "local",
            cwd: workspaceRoot,
            workspaceRoot,
            ...(selectedPath ? { path: selectedPath } : {}),
          },
          stateKey: 0,
          state: tabState,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        }}
        activeSession={activeSession}
        project={projectless ? null : project}
        onOpenFileTab={async () => undefined}
      />
    </div>
  );
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

function useMockWorkspaceFilesBridge(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const fileSearch = createFileSearchFixture(Object.values(directoryEntries).flat());
    const previousApi = window.api;
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        invoke: async (channel: string, ...args: unknown[]) => {
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
            const input = args[0] as { path: string };
            const unsupported = input.path.endsWith(".zip");
            return {
              isFile: true,
              sizeBytes: unsupported ? 12_000 : (fileContents[input.path]?.length ?? 0),
              createdAtMs: Date.parse(CREATED_AT),
              mtimeMs: Date.parse(CREATED_AT),
              contentKind: unsupported ? "binary" : "text",
            };
          }
          if (channel === "read-file") {
            const input = args[0] as { path: string };
            return {
              contents: fileContents[input.path] ?? "",
            };
          }
          if (channel.startsWith("file-search:")) return fileSearch.invoke(channel, args[0]);
          if (channel === "workspace-file-watch:start") {
            return { subscriptionId: "00000000-0000-4000-8000-000000000001" };
          }
          if (channel === "workspace-file-watch:stop") return undefined;
          if (channel === "write-file") {
            return { outcome: "saved", mtimeMs: Date.now() };
          }
          if (channel === "open-file") return true;
          return null;
        },
        on: fileSearch.on,
        off: () => undefined,
      },
    });
    setReady(true);
    return () => {
      Object.defineProperty(window, "api", {
        configurable: true,
        value: previousApi,
      });
    };
  }, []);
  return ready;
}
