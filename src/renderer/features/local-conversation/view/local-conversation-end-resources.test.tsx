import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { LocalConversationEndResources } from "./local-conversation-end-resources";
import { collectTurnEndResources } from "../projection/thread-summary-panel-output-model";

const ports = vi.hoisted(() => ({ openFile: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/lib/file-reference-router", () => ({
  useFileReferenceRouter: () => ({ open: ports.openFile }),
}));
vi.mock("@/lib/file-system-operations", () => ({ openExternalUrl: ports.openUrl }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function resources(count: number) {
  return collectTurnEndResources(
    {
      threadId: "thread",
      turnId: "turn",
      status: "completed",
      itemIds: ["assistant"],
      items: [
        {
          threadId: "thread",
          turnId: "turn",
          itemId: "assistant",
          entryId: "assistant",
          type: "agentMessage",
          kind: "assistantMessage",
          semanticKind: "assistantMessage",
          markdownText: Array.from(
            { length: count },
            (_, index) => `[result ${index}](output-${index}.pdf)`,
          ).join(" "),
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    },
    { cwd: "/workspace" },
  );
}

describe("ordinary completed response resources", () => {
  test("shows four resources without hiding one behind an expansion control", () => {
    render(<LocalConversationEndResources resources={resources(4)} hostId="local" />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });

  test("shows three of five and expands once without adding a collapse action", async () => {
    render(<LocalConversationEndResources resources={resources(5)} hostId="local" />);
    expect(screen.getAllByRole("button")).toHaveLength(4);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    });
    expect(screen.getAllByRole("button")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /Show|Collapse/ })).toBeNull();
  });

  test("opens the actual resource through the host-qualified file owner", async () => {
    ports.openFile.mockResolvedValue(true);
    render(
      <LocalConversationEndResources
        resources={resources(1)}
        hostId="ssh:remote"
        cwd="/workspace"
        workspaceRoot="/workspace"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "output-0.pdf" }));
    });
    await waitFor(() =>
      expect(ports.openFile).toHaveBeenCalledWith(
        { path: "/workspace/output-0.pdf" },
        {
          hostId: "ssh:remote",
          cwd: "/workspace",
          workspaceRoot: "/workspace",
          title: "output-0.pdf",
        },
      ),
    );
    expect(ports.openUrl).not.toHaveBeenCalled();
  });
});
