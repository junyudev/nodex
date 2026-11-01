import { useLayoutEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useTurnEndResources, useThreadSummaryOutputRows } from "./use-turn-end-resources";
import { buildTurnRenderModel } from "./projection/build-turn-render-model";
import { resolveGeneratedImageOutputState } from "./projection/generated-image-output";
import type { WorkspacePathStatesResult } from "../../../shared/types";
import type { CodexConversationTurn } from "../../lib/types";

const ports = vi.hoisted(() => ({ exists: vi.fn() }));
vi.mock("../../lib/workspace-file-operations", () => ({ readWorkspacePathStates: ports.exists }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const turn: CodexConversationTurn = {
  threadId: "thread",
  turnId: "turn",
  status: "completed",
  itemIds: ["assistant", "image"],
  diff: "diff --git a/deck.pptx b/deck.pptx\n--- a/deck.pptx\n+++ b/deck.pptx\n@@ -1 +1 @@\n-old\n+new",
  items: [
    {
      threadId: "thread",
      turnId: "turn",
      itemId: "assistant",
      entryId: "assistant",
      type: "agentMessage",
      kind: "assistantMessage",
      semanticKind: "assistantMessage",
      markdownText: "[deck](deck.pptx)",
      createdAt: 1,
      updatedAt: 1,
      status: "completed",
    },
    {
      threadId: "thread",
      turnId: "turn",
      itemId: "image",
      entryId: "image",
      type: "imageGeneration",
      kind: "systemEvent",
      semanticKind: "generatedImage",
      generatedImage: { src: "/workspace/preview.png", status: "completed" },
      rawItem: {
        type: "imageGeneration",
        savedPath: "/workspace/preview.png",
        status: "completed",
      },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};
type Result = { paths: readonly string[]; hasDiff: boolean; hasImage: boolean };
function Fixture({
  report,
  includeResources = true,
}: {
  report: (value: Result) => void;
  includeResources?: boolean;
}) {
  const result = useTurnEndResources({
    turn,
    hostId: "ssh:remote",
    cwd: "/workspace",
    includeResources,
  });
  const model = buildTurnRenderModel({
    turn,
    requests: [],
    isLatestTurn: true,
    isStreamingTurn: false,
    cwd: "/workspace",
    endResourcePaths: result.endResourcePaths,
  });
  const images = resolveGeneratedImageOutputState({
    items: turn.items,
    isTurnInProgress: false,
    endResourcePaths: result.endResourcePaths,
  });
  useLayoutEffect(() =>
    report({
      paths: result.endResourcePaths,
      hasDiff: model.buckets.unifiedDiffItem !== null,
      hasImage: images.shouldRender,
    }),
  );
  return (
    <output aria-label="resource labels">
      {result.resources.map(({ label }) => label).join(",")}
    </output>
  );
}
function mount(report: (value: Result) => void, includeResources = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <QueryClientProvider client={client}>
      <Fixture report={report} includeResources={includeResources} />
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

test("loading and resolved existence results control cards, diff and images together", async () => {
  const pending = { resolve: (_value: WorkspacePathStatesResult) => {} };
  const promise = new Promise<WorkspacePathStatesResult>((resolve) => {
    pending.resolve = resolve;
  });
  ports.exists.mockReturnValue(promise);
  const report = vi.fn();
  const fixture = mount(report);
  expect(report).toHaveBeenLastCalledWith({ paths: [], hasDiff: true, hasImage: true });
  expect(screen.queryByText("deck.pptx")).toBeNull();
  await act(async () => {
    pending.resolve({
      states: [{ path: "/workspace/deck.pptx", exists: true, isGitSourcePath: true }],
    });
    await promise;
  });
  await screen.findByText("deck.pptx");
  await waitFor(() =>
    expect(report).toHaveBeenLastCalledWith({
      paths: ["/workspace/deck.pptx"],
      hasDiff: false,
      hasImage: false,
    }),
  );
  expect(ports.exists).toHaveBeenCalledWith({
    hostId: "ssh:remote",
    cwd: "/workspace",
    paths: ["/workspace/deck.pptx"],
  });
  fixture.unmount();
  fixture.client.clear();
});

test("a missing file restores the ordinary diff and image presentation", async () => {
  ports.exists.mockResolvedValue({
    states: [{ path: "/workspace/deck.pptx", exists: false, isGitSourcePath: null }],
  });
  const report = vi.fn();
  const fixture = mount(report);
  await waitFor(() => expect(ports.exists).toHaveBeenCalledOnce());
  expect(report).toHaveBeenLastCalledWith({ paths: [], hasDiff: true, hasImage: true });
  expect(screen.queryByText("deck.pptx")).toBeNull();
  fixture.unmount();
  fixture.client.clear();
});

test("query failure retains the candidate and uses it for duplicate-output suppression", async () => {
  ports.exists.mockRejectedValue(new Error("Host connection changed"));
  const report = vi.fn();
  const fixture = mount(report);
  await screen.findByText("deck.pptx");
  await waitFor(() =>
    expect(report).toHaveBeenLastCalledWith({
      paths: ["/workspace/deck.pptx"],
      hasDiff: false,
      hasImage: false,
    }),
  );
  fixture.unmount();
  fixture.client.clear();
});

test("a non-owning timeline fragment neither queries nor suppresses completed outputs", () => {
  const report = vi.fn();
  const fixture = mount(report, false);
  expect(ports.exists).not.toHaveBeenCalled();
  expect(report).toHaveBeenLastCalledWith({ paths: [], hasDiff: true, hasImage: true });
  fixture.unmount();
  fixture.client.clear();
});

function SharedFixture({ cwd = "/workspace" }: { cwd?: string }) {
  const end = useTurnEndResources({ turn, hostId: "local", cwd, includeResources: true });
  const summary = useThreadSummaryOutputRows({ turns: [turn], hostId: "local", cwd });
  return (
    <>
      <output aria-label="turn outputs">
        {JSON.stringify(end.resources.map(({ kind }) => kind))}
      </output>
      <output aria-label="summary outputs">
        {JSON.stringify(summary.map(({ kind }) => kind))}
      </output>
    </>
  );
}

test("turn end and summary share batched path results while protocol images stay in the gallery", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  ports.exists.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    states: paths.map((path) => ({ path, exists: true, isGitSourcePath: true })),
  }));
  const fixture = render(
    <QueryClientProvider client={client}>
      <SharedFixture />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("summary outputs").textContent).toBe('["generated-image","file"]'),
  );
  expect(screen.getByLabelText("turn outputs").textContent).toBe('["file"]');
  expect(ports.exists).toHaveBeenCalledOnce();
  expect(ports.exists).toHaveBeenCalledWith({
    hostId: "local",
    cwd: "/workspace",
    paths: ["/workspace/deck.pptx", "/workspace/preview.png"],
  });
  fixture.rerender(
    <QueryClientProvider client={client}>
      <SharedFixture cwd="/other-repository" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ports.exists).toHaveBeenCalledTimes(2));
  fixture.unmount();
  client.clear();
});

test("summary removes missing files and protocol images with the same path confirmation", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  ports.exists.mockImplementation(async ({ paths }: { paths: string[] }) => ({
    states: paths.map((path) => ({ path, exists: false, isGitSourcePath: null })),
  }));
  const fixture = render(
    <QueryClientProvider client={client}>
      <SharedFixture />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ports.exists).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("summary outputs").textContent).toBe("[]");
  expect(screen.getByLabelText("turn outputs").textContent).toBe("[]");
  fixture.unmount();
  client.clear();
});
