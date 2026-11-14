import { describe, expect, it } from "vitest";
import {
  describeAgentSupport,
  describeProjectScope,
  isCodexOnlyServer,
  toggleProjectInScope,
} from "./plugin-agent-support";

const projects = [
  { id: "a", name: "Atlas" },
  { id: "b", name: "Beacon" },
];

describe("describeAgentSupport", () => {
  it("names every Agent when the whole plugin reaches them", () => {
    expect(describeAgentSupport({ outsideCodex: "full", limitations: [] })).toEqual({
      agents: "Codex, Claude Code and ACP agents",
      codexOnly: null,
    });
  });

  it("lists what stays in Codex", () => {
    expect(
      describeAgentSupport({
        outsideCodex: "partial",
        limitations: [
          { kind: "mcp-server-needs-sign-in", serverKey: "figma" },
          { kind: "connected-app", name: "Linear" },
          { kind: "hooks" },
        ],
      }).codexOnly,
    ).toBe("Only in Codex: figma (needs sign-in), Linear, hooks");
  });

  it("summarizes the kinds that stay in Codex where each part is marked", () => {
    expect(
      describeAgentSupport(
        {
          outsideCodex: "partial",
          limitations: [
            { kind: "mcp-server-needs-sign-in", serverKey: "figma" },
            { kind: "mcp-server-needs-sign-in", serverKey: "linear" },
            { kind: "hooks" },
          ],
        },
        "kinds",
      ).codexOnly,
    ).toBe("Servers that need a sign-in and hooks work only in Codex");
  });

  it("says Codex only when nothing reaches other Agents", () => {
    expect(
      describeAgentSupport({ outsideCodex: "none", limitations: [{ kind: "hooks" }] }),
    ).toEqual({ agents: "Codex only", codexOnly: null });
  });
});

describe("isCodexOnlyServer", () => {
  it("marks only servers that need a sign-in", () => {
    const support = {
      outsideCodex: "partial" as const,
      limitations: [{ kind: "mcp-server-needs-sign-in" as const, serverKey: "figma" }],
    };
    expect(isCodexOnlyServer(support, "figma")).toBe(true);
    expect(isCodexOnlyServer(support, "local")).toBe(false);
  });
});

describe("project scope", () => {
  it("labels all, one and several Projects", () => {
    expect(describeProjectScope({ kind: "all" }, projects)).toBe("All projects");
    expect(describeProjectScope({ kind: "projects", projectIds: ["b"] }, projects)).toBe("Beacon");
    expect(describeProjectScope({ kind: "projects", projectIds: ["a", "b"] }, projects)).toBe(
      "2 projects",
    );
  });

  it("narrows from all to the chosen Project and keeps the last one chosen", () => {
    const one = toggleProjectInScope({ kind: "all" }, "a");
    expect(one).toEqual({ kind: "projects", projectIds: ["a"] });
    const two = toggleProjectInScope(one, "b");
    expect(two).toEqual({ kind: "projects", projectIds: ["a", "b"] });
    expect(toggleProjectInScope(two, "a")).toEqual({ kind: "projects", projectIds: ["b"] });
    expect(toggleProjectInScope({ kind: "projects", projectIds: ["b"] }, "b")).toEqual({
      kind: "projects",
      projectIds: ["b"],
    });
  });
});
