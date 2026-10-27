import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { WorkspaceFilesPanel } from "@/features/workspace-files/workspace-files-panel";
import { ThreadStartProgressPanel } from "@/features/local-conversation/view/local-conversation-thread-body-owner";
import { ToolCallRawDialog } from "@/features/local-conversation/view/shared/tools/tool-call-inspection";
import { createMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import type { Project, ProjectSession } from "@/lib/types";
import { createLargeContentFixtures } from "../../../src/main/performance/large-content-fixtures";
import { formatBoundedWorktreeOutput } from "../../../src/shared/worktree-output";
import "../../../src/renderer/globals.css";

type Scenario = "workspace" | "markdown" | "tool" | "startup";

const fixtures = createLargeContentFixtures();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
});
const maitaiStore = createMaitaiStore({ queryClient });
const workspaceRoot = "/performance/workspace";
const plainPath = `${workspaceRoot}/large-source.txt`;
const markdownPath = `${workspaceRoot}/large-source.md`;

const project: Project = {
  id: "large-content-performance",
  libraryId: "library:performance",
  databaseId: "database:performance",
  defaultDatabaseViewId: "view:performance",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Large content performance",
  description: "",
  appearance: {
    color: "black",
    marker: { kind: "icon", icon: "folder" },
  },
  sources: [{ root: workspaceRoot, order: 0 }],
  primaryWorkspaceRoot: workspaceRoot,
  pinned: false,
  pinnedOrder: null,
  created: new Date(0),
  updated: new Date(0),
};

function buildSession(): ProjectSession {
  const createdAt = new Date(0).toISOString();
  return {
    id: "session:large-content-performance",
    projectId: project.id,
    noThreadFallbackTitle: "Large content performance",
    displayTitle: "Large content performance",
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function selectedWorkspaceContent(path: string): string {
  return path.endsWith(".md") ? fixtures.workspaceMarkdown : fixtures.workspacePlainText;
}

function installFixtureBridge(): void {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "workspace-directory-entries") {
          return { directoryPath: "", parentPath: null, entries: [] };
        }
        if (channel === "read-file-metadata") {
          const input = args[0] as { path: string };
          return {
            isFile: true,
            sizeBytes: selectedWorkspaceContent(input.path).length,
            createdAtMs: 0,
            mtimeMs: 0,
            contentKind: "text",
          };
        }
        if (channel === "read-file") {
          const input = args[0] as { path: string };
          return { contents: selectedWorkspaceContent(input.path) };
        }
        if (channel === "open-file") return true;
        return null;
      },
      on: () => () => undefined,
      off: () => undefined,
    },
  });
}

function WorkspaceScenario({ markdown }: { readonly markdown: boolean }) {
  const path = markdown ? markdownPath : plainPath;
  const session = buildSession();
  return (
    <WorkspaceFilesPanel
      tab={{
        id: "files:large-content-performance",
        sessionId: session.id,
        projectId: project.id,
        browserTabId: null,
        panelId: "right",
        kind: "files",
        title: path.split("/").at(-1) ?? "Files",
        order: 0,
        config: {
          projectId: project.id,
          hostId: "local",
          cwd: workspaceRoot,
          workspaceRoot,
          path,
        },
        stateKey: 0,
        state: { richView: Boolean(markdown) },
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }}
      activeSession={session}
      project={project}
      onOpenFileTab={async () => undefined}
    />
  );
}

function StartupScenario() {
  const setupProgressLogRef = useRef<HTMLDivElement | null>(null);
  const retainedTail = fixtures.setupLogDelta.slice(-32_000);
  return (
    <div className="flex h-full items-center justify-center">
      <ThreadStartProgressPanel
        progress={{
          runInTarget: "newWorktree",
          phase: "runningSetup",
          message: "Preparing worktree…",
          outputText: retainedTail,
          outputTruncated: true,
          updatedAt: 1,
        }}
        outputText={formatBoundedWorktreeOutput({ text: retainedTail, didTruncate: true })}
        setupProgressLogRef={setupProgressLogRef}
      />
    </div>
  );
}

function ScenarioSurface({ scenario }: { readonly scenario: Scenario }) {
  if (scenario === "workspace") {
    return <WorkspaceScenario markdown={false} />;
  }
  if (scenario === "markdown") {
    return <WorkspaceScenario markdown />;
  }
  if (scenario === "tool") {
    return (
      <ToolCallRawDialog
        open
        onOpenChange={() => undefined}
        title="Raw large tool output"
        getRawValue={() => fixtures.toolValue}
        triggerLabel="Show raw large tool output"
      />
    );
  }
  return <StartupScenario />;
}

function FixtureApp() {
  const scenario = new URLSearchParams(window.location.search).get("scenario") as Scenario | null;
  const [running, setRunning] = useState(false);
  if (!scenario) throw new Error("A large-content performance scenario is required");

  return (
    <QueryClientProvider client={queryClient}>
      <MaitaiProvider store={maitaiStore}>
        <NodexTooltipProvider>
          <main className="h-screen min-h-0 bg-token-main-surface-primary text-token-foreground">
            {running ? (
              <div data-performance-surface={scenario} className="h-full min-h-0">
                <ScenarioSurface scenario={scenario} />
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <button
                  type="button"
                  data-run-scenario={scenario}
                  className="m-2 w-fit rounded-md border border-token-border px-3 py-1.5 text-sm"
                  onClick={() => setRunning(true)}
                >
                  Run {scenario}
                </button>
                <LazySourceViewer
                  value={"warm viewport reader\n".repeat(100)}
                  ariaLabel="Warm viewport reader"
                  className="min-h-0 flex-1"
                />
              </div>
            )}
            {running ? (
              <button
                type="button"
                data-reset-scenario
                className="fixed bottom-2 right-2 z-100 rounded-md bg-token-background-secondary px-2 py-1 text-xs"
                onClick={() => setRunning(false)}
              >
                Reset
              </button>
            ) : null}
          </main>
        </NodexTooltipProvider>
      </MaitaiProvider>
    </QueryClientProvider>
  );
}

installFixtureBridge();
createRoot(document.getElementById("root")!).render(<FixtureApp />);
