import { act, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithMaitai } from "@/test/thread-maitai";
import type { ClaudeRuntimeDiagnostics } from "../../../../shared/claude-models";
import { useOpenNativeRuntimeDiagnostics } from "./native-runtime-diagnostics";

test("reads the live native runtime when its status dialog is explicitly opened", async () => {
  const read = vi.fn(async (): Promise<ClaudeRuntimeDiagnostics> => ({
    health: {
      status: "ready",
      executable: "/tool/claude",
      version: "1.2.3",
      account: null,
      error: null,
    },
    mcpServers: [
      { name: "nodex_app", status: "connected" },
      { name: "project", status: "failed", error: "Unavailable" },
    ],
    agents: [{ name: "reviewer", description: "Review code" }],
    capabilities: ["mcp", "agents"],
  }));
  function Consumer() {
    const open = useOpenNativeRuntimeDiagnostics(read);
    return (
      <>
        <button onClick={open}>Inspect</button>
        <NodexModalHost />
      </>
    );
  }
  const view = renderWithMaitai(<Consumer />);
  expect(read).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(view.getByText("Inspect"));
  });
  const servers = await view.findByRole("region", { name: "MCP servers" });
  expect(servers.textContent).toContain("nodex_app");
  expect(servers.textContent).toContain("connected");
  expect(servers.textContent).toContain("Unavailable");
  expect(read).toHaveBeenCalledTimes(1);
});
