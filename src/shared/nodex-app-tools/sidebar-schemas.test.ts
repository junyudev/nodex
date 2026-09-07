import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vite-plus/test";
import { sidebarSchemas, sidebarToolCatalog } from "./sidebar-schemas";

describe("Sidebar native tool contracts", () => {
  it("publishes both mixed and built-in order forms as valid MCP object inputs", () => {
    for (const tool of sidebarToolCatalog) expect(ToolSchema.safeParse(tool).success).toBe(true);
    expect(
      sidebarSchemas.reorder_section.parse({ sectionId: "section:custom", items: [] }),
    ).toEqual({ sectionId: "section:custom", items: [] });
    expect(
      sidebarSchemas.reorder_section.parse({
        sectionId: "section:pinned",
        sessionIds: ["draft:a", "acp:b"],
        expectedOrderRevision: "order:1",
      }),
    ).toMatchObject({ sessionIds: ["draft:a", "acp:b"] });
  });

  it("rejects ambiguous order forms, missing fences and caller-supplied authority", () => {
    for (const input of [
      { sectionId: "section:pinned", sessionIds: [] },
      { sectionId: "section:pinned", sessionIds: [], expectedOrderRevision: "order:1", items: [] },
      { sectionId: "section:custom", items: [], actorProjectId: "project:other" },
    ])
      expect(sidebarSchemas.reorder_section.safeParse(input).success).toBe(false);
    expect(
      sidebarSchemas.reorder_sidebar_projects.safeParse({
        sectionId: "section:projects",
        projectIds: [],
      }).success,
    ).toBe(false);
    expect(
      sidebarSchemas.list_sidebar_order.safeParse({
        sectionId: "section:pinned",
        itemKind: "thread",
      }).success,
    ).toBe(false);
  });
});
