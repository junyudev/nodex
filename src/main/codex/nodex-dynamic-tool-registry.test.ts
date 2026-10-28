import { NODEX_MARKDOWN_COMPACT_HINT } from "../../shared/nodex-markdown/agent-guide";
import { describe, expect, test } from "vite-plus/test";
import {
  NODEX_APP_V6_TOOLS,
  NODEX_APP_V6_TOOLSET_REVISION,
  NODEX_APP_TOOL_NAMESPACE,
} from "../../shared/nodex-agent-tools";
import {
  createNodexV3DynamicToolRegistry,
  type NodexAgentV3ToolHandlers,
} from "./nodex-dynamic-tool-registry";

function unimplemented(): never {
  throw new Error("Executor is not used by this catalog test");
}

describe("createNodexV3DynamicToolRegistry", () => {
  test("publishes the compact-identity catalog with only common reads eager", () => {
    const handlers = Object.fromEntries(
      NODEX_APP_V6_TOOLS.map((tool) => [tool, unimplemented]),
    ) as unknown as NodexAgentV3ToolHandlers<null>;
    const registry = createNodexV3DynamicToolRegistry(handlers);
    const catalog = registry.buildCatalog([
      {
        namespace: NODEX_APP_TOOL_NAMESPACE,
        toolsetRevision: NODEX_APP_V6_TOOLSET_REVISION,
      },
    ]);
    const namespace = catalog[0];
    expect(namespace?.type).toBe("namespace");
    if (!namespace || namespace.type !== "namespace") return;

    expect(namespace.description).toContain(NODEX_MARKDOWN_COMPACT_HINT);
    expect(namespace.description).not.toMatch(/\bNFM\b|Nested Markdown/u);
    expect(namespace.tools.map((tool) => tool.name).sort()).toEqual([...NODEX_APP_V6_TOOLS].sort());
    expect(
      namespace.tools
        .filter((tool) => tool.deferLoading === false)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["fetch", "get_context", "search"]);
  });
});
