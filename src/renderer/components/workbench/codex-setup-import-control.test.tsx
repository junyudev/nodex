import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import type { AgentImportScan } from "../../../shared/agent-import";
import { render } from "../../test/dom";
import {
  CodexSetupImportControl,
  type CodexSetupImportRuntime,
} from "./codex-setup-import-control";

const claudeScan: AgentImportScan = {
  scanId: "scan-1",
  sourceKind: "claude-code",
  sourceLabel: "Claude Code",
  sourceHome: "/home/.claude",
  expiresAt: Date.now() + 600_000,
  items: [
    {
      id: "skills",
      kind: "skills",
      label: "Skills",
      description: "Copies skills this Codex home does not have yet.",
      count: 4,
      defaultSelected: true,
    },
    {
      id: "mcp",
      kind: "mcpServers",
      label: "MCP servers",
      description: "Adds missing server definitions.",
      count: 2,
      defaultSelected: false,
    },
  ],
};
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};

it("reviews Claude Code setup and copies only the selected categories", async () => {
  const apply = vi.fn<CodexSetupImportRuntime["apply"]>().mockResolvedValue({
    importId: "import-1",
    sourceKind: "claude-code",
    sourceLabel: "Claude Code",
    startedAt: 1,
    completedAt: 2,
    outcomes: [
      {
        itemId: "skills",
        kind: "skills",
        label: "Skills",
        successCount: 3,
        skippedCount: 0,
        failureCount: 1,
        messages: ["review-pr has an invalid manifest."],
      },
    ],
  });
  const runtime: CodexSetupImportRuntime = {
    scan: vi.fn().mockResolvedValue(claudeScan),
    scanPickedHome: vi.fn(),
    apply,
  };
  render(<CodexSetupImportControl open runtime={runtime} />);
  await click(screen.getByRole("button", { name: "Claude Code" }));

  const review = await screen.findByRole("group", { name: "Setup from Claude Code" });
  expect(runtime.scan).toHaveBeenCalledWith("claude-code");
  expect(within(review).getByText("/home/.claude")).toBeTruthy();
  expect(within(review).getByText("Copies skills this Codex home does not have yet.")).toBeTruthy();
  expect(
    within(review).getByRole("checkbox", { name: "Skills" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    within(review).getByRole("checkbox", { name: "MCP servers" }).getAttribute("aria-checked"),
  ).toBe("false");

  await click(within(review).getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(apply).toHaveBeenCalledWith("scan-1", ["skills"]));
  const status = await screen.findByRole("status");
  expect(within(status).getByText("3 added · 1 failed")).toBeTruthy();
  expect(within(status).getByText("Skills: review-pr has an invalid manifest.")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Setup from Claude Code" })).toBeNull();
});

it("leaves the page unchanged when no other Codex home is chosen, and says when nothing is new", async () => {
  const scanPickedHome = vi
    .fn<CodexSetupImportRuntime["scanPickedHome"]>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      ...claudeScan,
      sourceKind: "codex",
      sourceLabel: "Codex",
      sourceHome: "/old/.codex",
      items: [],
    });
  render(
    <CodexSetupImportControl open runtime={{ scan: vi.fn(), scanPickedHome, apply: vi.fn() }} />,
  );
  await click(screen.getByRole("button", { name: "Other Codex home" }));
  await waitFor(() => expect(scanPickedHome).toHaveBeenCalledWith("codex"));
  expect(screen.queryByRole("group")).toBeNull();

  await click(screen.getByRole("button", { name: "Other Codex home" }));
  const review = await screen.findByRole("group", { name: "Setup from Codex" });
  expect(within(review).getByText("Nothing new to copy from Codex.")).toBeTruthy();
  expect(within(review).queryByRole("button", { name: "Copy" })).toBeNull();
  await click(within(review).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("group", { name: "Setup from Codex" })).toBeNull();
});
