import { fireEvent } from "@testing-library/react";
import { act, useState } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithMaitai } from "@/test/thread-maitai";
import { AutoReviewStatsIndicator, UsedSkillsIndicator } from "./thread-footer-metadata";

const { openFile } = vi.hoisted(() => ({ openFile: vi.fn(async () => true) }));
vi.mock("@/lib/file-reference-router", () => ({
  useFileReferenceRouter: () => ({ open: openFile }),
}));
vi.mock("@tanstack/react-query", () => ({
  queryOptions: (options: unknown) => options,
  useQuery: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../use-codex-mcp-apps", () => ({ useCodexMcpApps: () => ({ data: [] }) }));

describe("footer automatic review", () => {
  test("opens decisions and rationale in a modal that survives trigger removal without activating its row", async () => {
    const parentPointerDown = vi.fn();
    let removeTrigger = () => {};
    function Harness() {
      const [visible, setVisible] = useState(true);
      removeTrigger = () => setVisible(false);
      return (
        <NodexTooltipProvider>
          {visible ? (
            <div onPointerDown={parentPointerDown}>
              <AutoReviewStatsIndicator
                reviews={[
                  {
                    id: "review",
                    command: "rm protected-file",
                    decision: "rejected",
                    durationMs: 1200,
                    rationale: "The user did not authorize this action",
                  },
                ]}
              />
            </div>
          ) : null}
          <NodexModalHost />
        </NodexTooltipProvider>
      );
    }
    const view = renderWithMaitai(<Harness />);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Auto-review stats (1 rejected)" }));
      await Promise.resolve();
    });
    const dialog = await view.findByRole("dialog", { name: "Auto-review stats" });
    expect(view.getByText("rm protected-file")).toBeTruthy();
    expect(view.getByText("The user did not authorize this action")).toBeTruthy();
    const summary = view.getByText("rm protected-file").closest("summary");
    const details = summary?.closest("details");
    expect(details?.open).toBe(false);
    await act(async () => {
      summary?.click();
      await Promise.resolve();
    });
    expect(details?.open).toBe(true);
    expect(view.getByRole("list", { name: "Command history" }).tabIndex).toBe(0);
    parentPointerDown.mockClear();
    await act(async () => {
      fireEvent.pointerDown(dialog);
      removeTrigger();
      await Promise.resolve();
    });
    expect(parentPointerDown).not.toHaveBeenCalled();
    expect(view.getByRole("dialog", { name: "Auto-review stats" })).toBeTruthy();
  });
});

describe("used skills", () => {
  test("opens a tooltip from its closed state and preserves cwd and modifier clicks", async () => {
    openFile.mockClear();
    const view = renderWithMaitai(
      <NodexTooltipProvider>
        <UsedSkillsIndicator
          skills={[{ path: "/work/.agents/skills/demo/SKILL.md", name: "Demo", source: "Project" }]}
          cwd="/work"
          hostId="local"
        />
      </NodexTooltipProvider>,
    );
    await act(async () => {
      view.getByRole("button", { name: "Skills" }).focus();
      await Promise.resolve();
    });
    const link = await view.findByRole("link", { name: "Demo" });
    await act(async () => {
      fireEvent.click(link, { metaKey: true });
      await Promise.resolve();
    });
    expect(openFile).toHaveBeenCalledWith(
      { path: "/work/.agents/skills/demo/SKILL.md" },
      { cwd: "/work", external: true },
    );
  });
  test("cannot open a remote skill against the local filesystem", async () => {
    openFile.mockClear();
    const view = renderWithMaitai(
      <NodexTooltipProvider>
        <UsedSkillsIndicator
          skills={[
            { path: "/work/.agents/skills/demo/SKILL.md", name: "Remote demo", source: "Project" },
          ]}
          cwd="/work"
          hostId="remote-host"
        />
      </NodexTooltipProvider>,
    );
    await act(async () => {
      view.getByRole("button", { name: "Skills" }).focus();
      await Promise.resolve();
    });
    const unavailable = await view.findByRole("link", { name: "Remote demo" });
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(unavailable);
      await Promise.resolve();
    });
    expect(openFile).not.toHaveBeenCalled();
  });
});
