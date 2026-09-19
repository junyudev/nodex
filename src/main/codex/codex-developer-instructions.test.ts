import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexDesktopDeveloperInstructions,
  buildCodexThreadDeveloperInstructions,
} from "./codex-developer-instructions";

describe("Codex desktop developer instructions", () => {
  test("builds the exact side-chat envelope without thread tools and preserves base ordering", () => {
    const instructions = buildCodexDesktopDeveloperInstructions({
      baseInstructions: "Base instructions",
      gitSettings: { branchPrefix: "codex/" },
      workspaceDependenciesEnabled: true,
    });

    expect(
      instructions.startsWith("Base instructions\n\n<app-context>\n# Codex desktop context"),
    ).toBe(true);
    expect(instructions.includes("### Workspace Dependencies")).toBe(true);
    expect(instructions.includes("### Automations")).toBe(true);
    expect(instructions.includes("### Inline Code Comments")).toBe(true);
    expect(instructions.includes("### Git\n- Branch prefix: `codex/`")).toBe(true);
    expect(instructions.includes("### Thread Coordination")).toBe(false);
    expect(instructions.endsWith("</app-context>")).toBe(true);
  });

  test("omits git only for a confirmed non-git workspace and gates thread tools independently", () => {
    const instructions = buildCodexDesktopDeveloperInstructions({
      isNonGitWorkspace: true,
      threadToolsEnabled: true,
      workspaceDependenciesEnabled: false,
    });

    expect(instructions.includes("### Git")).toBe(false);
    expect(instructions.includes("### Thread Coordination")).toBe(true);
    expect(instructions.includes("### Workspace Dependencies")).toBe(false);
  });

  test("uses product-owned prose, heartbeat, and git section ordering", () => {
    const instructions = buildCodexDesktopDeveloperInstructions({
      gitSettings: {
        branchPrefix: "nodex/",
        commitInstructions: "Keep commits focused.",
      },
      heartbeatEnabled: true,
      includeProseDetailLevelInstructions: true,
      threadToolsEnabled: true,
      workspaceDependenciesEnabled: true,
    });

    const sectionOrder = [
      "# Codex desktop context",
      "### Workspace Dependencies",
      "### Automations",
      "### Thread Coordination",
      "### Non-technical UI",
      "### Inline Code Comments",
      "## Heartbeats",
      "### Git",
    ].map((section) => instructions.indexOf(section));
    expect(sectionOrder.every((index) => index >= 0)).toBe(true);
    expect(
      sectionOrder.every(
        (index, position) => position === 0 || index > (sectionOrder[position - 1] ?? -1),
      ),
    ).toBe(true);
    expect(instructions.includes("### Git\n- Branch prefix: `nodex/`")).toBe(true);
    expect(instructions.includes("- Commit instructions: Keep commits focused.")).toBe(true);
  });

  test("keeps workspace dependencies disabled unless capability support is explicit", () => {
    const instructions = buildCodexDesktopDeveloperInstructions();

    expect(instructions.includes("### Workspace Dependencies")).toBe(false);
    expect(instructions.includes("### Automations")).toBe(true);
  });

  test("appends writing and caller instructions without remote title or presentation experiments", () => {
    const instructions = buildCodexThreadDeveloperInstructions({
      writingBlockInstructions: true,
      additionalDeveloperInstructions: "Caller instructions",
    });
    const order = ["<app-context>", "### Writing blocks", "Caller instructions"].map((section) =>
      instructions.indexOf(section),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(
      order.every((index, position) => position === 0 || index > (order[position - 1] ?? -1)),
    ).toBe(true);
    expect(instructions.includes("### Task title checkpoints")).toBe(false);
    expect(instructions.includes("### Presentation outline writing blocks")).toBe(false);
  });
});
