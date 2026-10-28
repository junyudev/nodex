import { describe, expect, it, vi } from "vite-plus/test";
import type { CodexBackgroundTerminalRow } from "../../../shared/types";
import { createCodexBackgroundTerminalTasks } from "./codex-background-tasks";

const row = (id: string, processId: string | null): CodexBackgroundTerminalRow => ({
  id,
  turnId: "turn",
  command: `pnpm ${id}`,
  cwd: "/repo",
  processId,
  previewLine: null,
});

const actions = () => ({
  onStopBackgroundTerminals: vi.fn(async () => {}),
  onOpenBackgroundTerminalOutput: vi.fn(),
  onOpenProcessManager: vi.fn(),
});

describe("Codex background terminals", () => {
  it("stops a terminal alone when it has a process, and every terminal with Stop all", async () => {
    const host = actions();
    const background = createCodexBackgroundTerminalTasks(
      "thread",
      [row("dev", "41"), row("watch", null)],
      host,
    )!;
    expect(background.tasks.map((task) => [task.label, task.stoppable])).toEqual([
      ["pnpm dev", true],
      ["pnpm watch", false],
    ]);
    await background.stop("dev");
    expect(host.onStopBackgroundTerminals).toHaveBeenLastCalledWith("thread", ["41"]);
    await expect(background.stop("watch")).rejects.toThrow("only be stopped with Stop all");
    await background.stop();
    expect(host.onStopBackgroundTerminals).toHaveBeenLastCalledWith("thread");
  });

  it("opens a terminal's output and every process in their own surfaces", () => {
    const host = actions();
    const background = createCodexBackgroundTerminalTasks("thread", [row("dev", "41")], host)!;
    background.openOutput!("dev");
    expect(host.onOpenBackgroundTerminalOutput).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dev" }),
    );
    background.openAll!();
    expect(host.onOpenProcessManager).toHaveBeenCalledOnce();
    expect(background.readOutput).toBeUndefined();
  });

  it("has nothing to show without terminals", () => {
    expect(createCodexBackgroundTerminalTasks("thread", [], actions())).toBeNull();
  });
});
