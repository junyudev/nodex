import { useLayoutEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useTurnEndResources } from "./use-turn-end-resources";
import { LocalConversationEndResources } from "./view/local-conversation-end-resources";
import { buildTurnRenderModel } from "./projection/build-turn-render-model";
import { resolveGeneratedImageOutputState } from "./projection/generated-image-output";
import type { CodexConversationTurn } from "../../lib/types";

const ports = vi.hoisted(() => ({ exists: vi.fn(), open: vi.fn() }));
vi.mock("../../lib/workspace-file-operations", () => ({ readWorkspacePathsExist: ports.exists }));
vi.mock("@/lib/file-reference-router", () => ({
  useFileReferenceRouter: () => ({ open: ports.open }),
}));
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
  return <LocalConversationEndResources resources={result.resources} hostId="ssh:remote" />;
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
  const pending = { resolve: (_value: { existingPaths: string[] }) => {} };
  const promise = new Promise<{ existingPaths: string[] }>((resolve) => {
    pending.resolve = resolve;
  });
  ports.exists.mockReturnValue(promise);
  const report = vi.fn();
  const fixture = mount(report);
  expect(report).toHaveBeenLastCalledWith({ paths: [], hasDiff: true, hasImage: true });
  expect(screen.queryByRole("button", { name: "deck.pptx" })).toBeNull();
  await act(async () => {
    pending.resolve({ existingPaths: ["/workspace/deck.pptx"] });
    await promise;
  });
  await screen.findByRole("button", { name: "deck.pptx" });
  await waitFor(() =>
    expect(report).toHaveBeenLastCalledWith({
      paths: ["/workspace/deck.pptx"],
      hasDiff: false,
      hasImage: false,
    }),
  );
  expect(ports.exists).toHaveBeenCalledWith({
    hostId: "ssh:remote",
    paths: ["/workspace/deck.pptx"],
  });
  fixture.unmount();
  fixture.client.clear();
});

test("a missing file restores the ordinary diff and image presentation", async () => {
  ports.exists.mockResolvedValue({ existingPaths: [] });
  const report = vi.fn();
  const fixture = mount(report);
  await waitFor(() => expect(ports.exists).toHaveBeenCalledOnce());
  expect(report).toHaveBeenLastCalledWith({ paths: [], hasDiff: true, hasImage: true });
  expect(screen.queryByRole("button", { name: "deck.pptx" })).toBeNull();
  fixture.unmount();
  fixture.client.clear();
});

test("query failure retains the candidate and uses it for duplicate-output suppression", async () => {
  ports.exists.mockRejectedValue(new Error("Host connection changed"));
  const report = vi.fn();
  const fixture = mount(report);
  await screen.findByRole("button", { name: "deck.pptx" });
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
