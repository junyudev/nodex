import { describe, expect, test } from "vite-plus/test";
import { NODEX_AGENT_V3_CATALOG_BUDGETS } from "../../shared/nodex-agent-tools/budgets";
import {
  NODEX_MARKDOWN_AGENT_GUIDE,
  NODEX_MARKDOWN_COMPACT_HINT,
} from "../../shared/nodex-markdown/agent-guide";
import {
  formatDynamicToolCatalogMetrics,
  measureDynamicToolCatalog,
} from "./dynamic-tool-catalog-metrics";
import { buildNodexAgentV3DynamicToolCatalog } from "./nodex-dynamic-tool-registry";

describe("Nodex Agent catalog metrics", () => {
  test("renders one deterministic table with all cost centers", () => {
    const metrics = measureDynamicToolCatalog(buildNodexAgentV3DynamicToolCatalog());
    const first = formatDynamicToolCatalogMetrics(metrics);
    const second = formatDynamicToolCatalogMetrics(metrics);

    expect(first).toBe(second);
    expect(first.split("\n").filter((line) => line.includes("complete catalog"))).toHaveLength(1);
    for (const tool of metrics.tools) {
      expect(first.split("\n").filter((line) => line.startsWith(tool.name))).toHaveLength(1);
    }
  });

  test("rejects an absent or ambiguous namespace", () => {
    expect(() => measureDynamicToolCatalog([])).toThrow("exactly one dynamic-tool namespace");
    const catalog = buildNodexAgentV3DynamicToolCatalog();
    expect(() => measureDynamicToolCatalog([...catalog, ...catalog])).toThrow(
      "exactly one dynamic-tool namespace",
    );
  });

  test("keeps v3 within common-path and intent-tool budgets", () => {
    const catalog = buildNodexAgentV3DynamicToolCatalog();
    const metrics = measureDynamicToolCatalog(catalog);

    expect(metrics.eagerBytes).toBeLessThanOrEqual(NODEX_AGENT_V3_CATALOG_BUDGETS.eagerBytes);
    expect(metrics.completeBytes).toBeLessThanOrEqual(NODEX_AGENT_V3_CATALOG_BUDGETS.completeBytes);
    for (const tool of metrics.tools) {
      const budget =
        NODEX_AGENT_V3_CATALOG_BUDGETS.tools[
          tool.name as keyof typeof NODEX_AGENT_V3_CATALOG_BUDGETS.tools
        ];
      if (budget === undefined) continue;
      expect(tool.totalBytes, tool.name).toBeLessThanOrEqual(budget);
    }

    const namespace = catalog[0];
    expect(namespace?.type).toBe("namespace");
    if (!namespace || namespace.type !== "namespace") return;
    expect(namespace.description.split(NODEX_MARKDOWN_COMPACT_HINT)).toHaveLength(2);
    expect(Buffer.byteLength(NODEX_MARKDOWN_COMPACT_HINT, "utf8")).toBeLessThanOrEqual(
      NODEX_AGENT_V3_CATALOG_BUDGETS.namespaceHintBytes,
    );
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain(NODEX_MARKDOWN_AGENT_GUIDE.instructions);
    // The eager catalog names the one language and no retired format.
    expect(serialized).not.toMatch(/\bNFM\b|Nested Markdown|\bgfm\b/u);
    expect(
      namespace.tools.filter((tool) => tool.deferLoading !== true).map((tool) => tool.name),
    ).toEqual(["fetch", "get_context", "search"]);
  });
});
